import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { config } from '../config/env';
import { closeDb, prepare } from '../db/database';
import { runMigrations } from '../db/migrate';
import { createApp } from '../app';
import { uuid } from '../lib/ids';
import { nowIso } from '../lib/time';
import { outboxQueueDepth, processOnce } from '../engine/outbox';
import { closeNotificationStreams } from '../modules/notifications/notifications.routes';
import { metrics } from '../lib/metrics';

/**
 * HTTP-level tests: one per class of bug the audit found.
 *
 * The unit suites cover the primitives (JWT, scrypt, secretbox, ICS, the
 * heuristic parser) but not one request path, which is why none of them would
 * have caught a single finding — every bug lived in how the layers were wired
 * together. These drive the real Express app over a real socket against a real
 * SQLite file, so a regression in routing, middleware order, validation, auth or
 * the outbox shows up here rather than in production.
 *
 * No test framework or HTTP client is added: `node:test` plus global `fetch`
 * against `app.listen(0)`, consistent with the project's zero-dependency stance.
 *
 * Everything lives inside one outer `describe` on purpose. A `before`/`after`
 * pair at the top level of a file registers on the *root* suite, and since
 * index.test.ts imports every suite into a single process, this file's database
 * redirection would then wrap every other file's tests too.
 */

interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  /** Pre-serialized body, for deliberately malformed or oversized payloads. */
  raw?: string;
  headers?: Record<string, string>;
}

interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  refreshToken: string;
}

const INBOX_SECRET = 'integration-inbox-webhook-secret';
const WELCOME_TITLE = 'Welcome to DueKeeper';
const INBOX_NOTICE_TITLES = ['Deadline captured from email', 'Processed forwarded email'];

describe('http api', () => {
  let server: Server;
  let baseUrl = '';
  let tempDir = '';
  const savedDbPath = config.dbPath;
  const savedInboxToken = config.inboxWebhookToken;
  let userSeq = 0;

  before(async () => {
    // A throwaway database file per run: the suite writes real rows, and pointing
    // it at the developer's ./data/duekeeper.db would be both destructive and
    // order-dependent. `getDb()` resolves `config.dbPath` lazily on first use, so
    // closing the handle first is enough to redirect it.
    closeDb();
    tempDir = mkdtempSync(join(tmpdir(), 'duekeeper-http-'));
    config.dbPath = join(tempDir, 'integration.db');
    runMigrations();
    config.inboxWebhookToken = INBOX_SECRET;

    const app = createApp();
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    closeNotificationStreams();
    // fetch pools its sockets, so close() would otherwise sit waiting on idle
    // keep-alive connections that nothing is ever going to end.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    config.dbPath = savedDbPath;
    config.inboxWebhookToken = savedInboxToken;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* the OS will clean the temp dir up eventually */
    }
  });

  async function api<T = any>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    let payload: string | undefined;
    if (options.raw !== undefined) {
      payload = options.raw;
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? (payload !== undefined ? 'POST' : 'GET'),
      headers,
      body: payload
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, body: body as T, text };
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  }

  async function register(password = 'Password123'): Promise<TestUser> {
    userSeq += 1;
    const email = `http-${userSeq}-${Date.now()}@example.test`;
    const res = await api('/api/auth/register', {
      body: { email, password, displayName: `HTTP User ${userSeq}` }
    });
    assert.equal(res.status, 201, `register failed: ${res.text}`);
    return {
      id: res.body.user.id,
      email,
      password,
      token: res.body.accessToken,
      refreshToken: res.body.refreshToken
    };
  }

  const inFuture = (ms: number): string => new Date(Date.now() + ms).toISOString();

  async function createEvent(
    user: TestUser,
    overrides: Record<string, unknown> = {}
  ): Promise<Record<string, any>> {
    const res = await api('/api/events', {
      token: user.token,
      body: {
        title: 'Integration deadline',
        eventType: 'submission',
        dueAt: inFuture(5 * 86_400_000),
        timezone: 'Asia/Kolkata',
        ...overrides
      }
    });
    assert.equal(res.status, 201, `createEvent failed: ${res.text}`);
    return res.body.event;
  }

  function countRows(sql: string, ...params: Array<string | number>): number {
    const row = prepare(sql).get(...params) as { c: number };
    return Number(row.c);
  }

  async function notificationTitles(user: TestUser): Promise<string[]> {
    const res = await api('/api/notifications', { token: user.token });
    assert.equal(res.status, 200, res.text);
    return (res.body.notifications as Array<{ title: string }>).map((n) => n.title);
  }

  describe('auth and session revocation', () => {
    it('changing the password invalidates every existing session (C4)', async () => {
      const user = await register();
      const newPassword = 'RotatedPassword456';

      const changed = await api('/api/user/password', {
        token: user.token,
        body: { currentPassword: user.password, newPassword }
      });
      assert.equal(changed.status, 200, changed.text);
      assert.equal(changed.body.sessionsRevoked, true);

      // The access token issued before the change must stop working immediately —
      // not in fifteen minutes when it happens to expire.
      const me = await api('/api/auth/me', { token: user.token });
      assert.equal(me.status, 401);

      // And the refresh token must not be able to mint a fresh one.
      const refreshed = await api('/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
      assert.equal(refreshed.status, 401);

      const signedIn = await api('/api/auth/login', { body: { email: user.email, password: newPassword } });
      assert.equal(signedIn.status, 200, signedIn.text);
      assert.ok(signedIn.body.accessToken);
    });

    it('rotates refresh tokens and treats reuse as theft', async () => {
      const user = await register();

      const first = await api('/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
      assert.equal(first.status, 200, first.text);
      assert.notEqual(first.body.refreshToken, user.refreshToken, 'refresh must rotate the token');

      const second = await api('/api/auth/refresh', { body: { refreshToken: first.body.refreshToken } });
      assert.equal(second.status, 200, second.text);

      // Replaying an already-rotated token is the signature of a stolen one.
      const replay = await api('/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
      assert.equal(replay.status, 401);

      // The whole family goes with it, including the token the victim still holds…
      const afterTheft = await api('/api/auth/refresh', { body: { refreshToken: second.body.refreshToken } });
      assert.equal(afterTheft.status, 401);
      // …and the access token minted seconds ago, via the token version bump.
      const me = await api('/api/auth/me', { token: second.body.accessToken });
      assert.equal(me.status, 401);
    });

    it('throttles password guessing and says when to come back', async () => {
      const user = await register();
      let rateLimited: ApiResponse | null = null;

      for (let attempt = 0; attempt <= config.loginRateLimit; attempt += 1) {
        const res = await api('/api/auth/login', {
          body: { email: user.email, password: 'DefinitelyWrong999' }
        });
        if (res.status === 429) {
          rateLimited = res;
          break;
        }
        assert.equal(res.status, 401, `attempt ${attempt} expected 401, got ${res.status}`);
      }

      assert.ok(rateLimited, `expected a 429 within ${config.loginRateLimit + 1} attempts`);
      assert.equal(rateLimited.body.error.code, 'RATE_LIMITED');
      // Without this header every client has to guess how long to wait, and the
      // well-behaved ones guess short.
      const retryAfter = Number(rateLimited.headers.get('retry-after'));
      assert.ok(retryAfter >= 1, 'a 429 must carry a Retry-After header');
    });

    it('rejects requests with no, malformed, or unparseable bearer tokens', async () => {
      const cases: Array<Record<string, string>> = [
        {},
        { Authorization: 'Basic abc' },
        { Authorization: 'Bearer not.a.jwt' }
      ];
      for (const headers of cases) {
        const res = await api('/api/events', { headers });
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.equal(res.body.error.code, 'UNAUTHORIZED');
      }
    });
  });

  describe('datetime correctness (H5, H6)', () => {
    it('refuses an instant with no offset and a timezone that is not IANA', async () => {
      const user = await register();
      const base = { title: 'Thermodynamics midterm', eventType: 'exam', timezone: 'Asia/Kolkata' };

      // A naive date-time is the H5 bug: the server would have read it in its own
      // zone and every reminder for the deadline would fire hours off.
      const naive = await api('/api/events', {
        token: user.token,
        body: { ...base, dueAt: '2026-09-01T09:00:00' }
      });
      assert.equal(naive.status, 422, naive.text);
      assert.match(String(naive.body.error.details.dueAt), /offset/i);

      // A fixed offset is not a timezone: it cannot answer DST questions, which is
      // exactly what the planner and the local-date grouping need it for.
      const fixedOffsetZone = await api('/api/events', {
        token: user.token,
        body: { ...base, timezone: '+05:30', dueAt: '2026-09-01T09:00:00+05:30' }
      });
      assert.equal(fixedOffsetZone.status, 422, fixedOffsetZone.text);

      const madeUpZone = await api('/api/events', {
        token: user.token,
        body: { ...base, timezone: 'Mars/Olympus_Mons', dueAt: '2026-09-01T09:00:00+05:30' }
      });
      assert.equal(madeUpZone.status, 422, madeUpZone.text);

      // Date.parse would roll this silently forward to March 3rd.
      const impossible = await api('/api/events', {
        token: user.token,
        body: { ...base, dueAt: '2026-02-31T09:00:00+05:30' }
      });
      assert.equal(impossible.status, 422, impossible.text);

      const accepted = await api('/api/events', {
        token: user.token,
        body: { ...base, dueAt: '2026-09-01T09:00:00+05:30' }
      });
      assert.equal(accepted.status, 201, accepted.text);
      assert.equal(accepted.body.event.dueAt, '2026-09-01T03:30:00.000Z');
      assert.equal(accepted.body.event.timezone, 'Asia/Kolkata');
    });

    it('bounds snooze durations instead of overflowing Date (H6)', async () => {
      const user = await register();
      const event = await createEvent(user);

      for (const duration of ['9999d', '0m', '-30m', 'soon', '', '1y', '99999999999999d']) {
        const res = await api(`/api/events/${event.id}/snooze`, {
          token: user.token,
          body: { duration }
        });
        assert.equal(res.status, 422, `duration ${JSON.stringify(duration)} → ${res.status} ${res.text}`);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      }

      const ok = await api(`/api/events/${event.id}/snooze`, { token: user.token, body: { duration: '30m' } });
      assert.equal(ok.status, 200, ok.text);
      assert.ok(
        new Date(ok.body.event.dueAt).getTime() > new Date(event.dueAt).getTime(),
        'a successful snooze must move the deadline later'
      );
    });

    it('refuses to snooze a deadline that is already closed', async () => {
      const user = await register();
      const event = await createEvent(user);
      const done = await api(`/api/events/${event.id}/done`, { token: user.token, method: 'POST' });
      assert.equal(done.status, 200, done.text);

      // Snoozing used to force the status back to 'upcoming' and clear done_at,
      // quietly resurrecting a finished deadline and re-arming its reminders.
      const res = await api(`/api/events/${event.id}/snooze`, { token: user.token, body: { duration: '1h' } });
      assert.equal(res.status, 422, res.text);
      assert.match(res.body.error.message, /already done/i);
    });
  });

  describe('queued work follows the event (H8)', () => {
    it('cancels queued deliveries when an event is completed, and removes them when it is deleted', async () => {
      const user = await register();
      // Due in two hours with a one-hour reminder, so the delivery is inside the
      // planner horizon and really gets materialized.
      const event = await createEvent(user, {
        title: 'Lab report',
        dueAt: inFuture(2 * 3_600_000),
        timezone: 'UTC',
        reminders: [{ offsetSeconds: 3600, channel: 'in_app' }]
      });

      const pendingDeliveries = (): number =>
        countRows(
          `SELECT COUNT(*) AS c FROM reminder_deliveries WHERE event_id = ? AND status = 'pending'`,
          event.id
        );
      const liveOutbox = (): number =>
        countRows(
          `SELECT COUNT(*) AS c FROM notification_outbox
           WHERE status IN ('pending','processing')
             AND delivery_id IN (SELECT id FROM reminder_deliveries WHERE event_id = ?)`,
          event.id
        );

      assert.equal(pendingDeliveries(), 1, 'creating an event must queue its in-horizon reminder');
      assert.equal(liveOutbox(), 1, 'the delivery must have an outbox job beside it');

      const done = await api(`/api/events/${event.id}/done`, { token: user.token, method: 'POST' });
      assert.equal(done.status, 200, done.text);
      assert.equal(done.body.event.status, 'done');

      // This is the finding: marking a deadline done left the queued reminder live,
      // so the user got reminded about work they had already finished.
      assert.equal(pendingDeliveries(), 0, 'completing an event must cancel its pending deliveries');
      assert.equal(liveOutbox(), 0, 'completing an event must cancel its outbox jobs');

      const deleted = await api(`/api/events/${event.id}`, { token: user.token, method: 'DELETE' });
      assert.equal(deleted.status, 204);
      assert.equal(
        countRows('SELECT COUNT(*) AS c FROM reminder_deliveries WHERE event_id = ?', event.id),
        0,
        'deleting an event must leave no delivery rows behind'
      );
    });

    it('re-plans deliveries onto the new date when an event moves', async () => {
      const user = await register();
      const event = await createEvent(user, {
        title: 'Moved deadline',
        dueAt: inFuture(3 * 3_600_000),
        timezone: 'UTC',
        reminders: [{ offsetSeconds: 3600, channel: 'in_app' }]
      });

      const scheduledFor = (): string[] =>
        (
          prepare(
            `SELECT scheduled_for FROM reminder_deliveries WHERE event_id = ? AND status = 'pending'`
          ).all(event.id) as unknown as Array<{ scheduled_for: string }>
        ).map((row) => row.scheduled_for);

      const originalSchedule = scheduledFor();
      assert.equal(originalSchedule.length, 1);

      const movedDueAt = inFuture(5 * 3_600_000);
      const updated = await api(`/api/events/${event.id}`, {
        token: user.token,
        method: 'PUT',
        body: {
          title: 'Moved deadline',
          eventType: 'submission',
          dueAt: movedDueAt,
          timezone: 'UTC',
          reminders: [{ offsetSeconds: 3600, channel: 'in_app' }]
        }
      });
      assert.equal(updated.status, 200, updated.text);

      const newSchedule = scheduledFor();
      assert.equal(newSchedule.length, 1, 'exactly one pending delivery should remain');
      assert.notEqual(newSchedule[0], originalSchedule[0], 'the delivery must move with the deadline');
      assert.equal(
        newSchedule[0],
        new Date(new Date(movedDueAt).getTime() - 3_600_000).toISOString(),
        'the new delivery must sit one hour before the new due date'
      );
    });
  });

  describe('list pagination', () => {
    it('reports a total and clamps or rejects bad page parameters', async () => {
      const user = await register();
      for (let i = 1; i <= 3; i += 1) {
        await createEvent(user, { title: `Paged ${i}`, dueAt: inFuture(i * 86_400_000) });
      }

      const firstPage = await api('/api/events?limit=2', { token: user.token });
      assert.equal(firstPage.status, 200, firstPage.text);
      assert.equal(firstPage.body.events.length, 2);
      // Without a total, a client cannot tell a short page from a truncated one.
      assert.equal(firstPage.body.page.total, 3);
      assert.equal(firstPage.body.page.hasMore, true);

      const secondPage = await api('/api/events?limit=2&offset=2', { token: user.token });
      assert.equal(secondPage.body.events.length, 1);
      assert.equal(secondPage.body.page.hasMore, false);

      // Asking for more than the server will give is clamped, not refused.
      const clamped = await api('/api/events?limit=100000', { token: user.token });
      assert.equal(clamped.status, 200);
      assert.equal(clamped.body.page.limit, config.maxListPageSize);

      // A broken parameter used to fall back to the default, so a client with a bug
      // received a plausible-looking wrong page and never found out.
      for (const query of ['limit=abc', 'limit=-1', 'offset=abc', 'status=bogus']) {
        const res = await api(`/api/events?${query}`, { token: user.token });
        assert.equal(res.status, 422, `${query} → ${res.status} ${res.text}`);
      }

      const notifications = await api('/api/notifications?limit=1', { token: user.token });
      assert.equal(notifications.status, 200, notifications.text);
      assert.equal(typeof notifications.body.page.total, 'number');
      assert.equal(typeof notifications.body.unreadCount, 'number');
    });
  });

  describe('cross-user isolation', () => {
    it('never lets one account read or mutate another account’s deadline', async () => {
      const owner = await register();
      const stranger = await register();
      const event = await createEvent(owner, { title: 'Private deadline' });

      const attempts: Array<[string, string, unknown]> = [
        ['GET', '', undefined],
        ['POST', '/done', {}],
        ['POST', '/cancel', {}],
        ['POST', '/snooze', { duration: '1h' }],
        ['DELETE', '', undefined]
      ];

      for (const [method, suffix, body] of attempts) {
        const res = await api(`/api/events/${event.id}${suffix}`, {
          token: stranger.token,
          method,
          body
        });
        // 404, not 403: a stranger should not even learn the id exists.
        assert.equal(res.status, 404, `${method} ${suffix} → ${res.status} ${res.text}`);
      }

      const stillThere = await api(`/api/events/${event.id}`, { token: owner.token });
      assert.equal(stillThere.status, 200, 'the owner must still have their event');
      assert.equal(stillThere.body.event.title, 'Private deadline');
      assert.equal(stillThere.body.event.status, 'upcoming', 'no stranger mutation may have landed');

      const strangerList = await api('/api/events', { token: stranger.token });
      assert.equal(strangerList.body.events.length, 0);
    });
  });

  describe('notification stream authentication', () => {
    it('re-checks revocation on the bearer-header path', async () => {
      const user = await register();

      // The header path exists for non-browser clients (curl, native apps), and
      // a live session must still be able to use it.
      const opened = await fetch(`${baseUrl}/api/notifications/stream`, {
        headers: { Authorization: `Bearer ${user.token}` }
      });
      assert.equal(opened.status, 200);
      assert.match(opened.headers.get('content-type') ?? '', /text\/event-stream/);
      await opened.body!.cancel();

      const revoked = await api('/api/user/sessions/revoke-all', { token: user.token, method: 'POST' });
      assert.equal(revoked.status, 200, revoked.text);

      // The finding: this route called `verifyJwt` directly instead of going
      // through the shared helper, so it never re-read `token_version`. A JWT
      // stays cryptographically valid until it expires — so a session ended by a
      // password change or sign-out-everywhere could still open a stream and keep
      // receiving that account's notifications for the rest of the token's life.
      const afterRevoke = await api('/api/notifications/stream', {
        headers: { Authorization: `Bearer ${user.token}` }
      });
      assert.equal(afterRevoke.status, 401);
      assert.match(afterRevoke.body.error.message, /revoked/i);
    });

    it('takes a single-use ticket and refuses an access token in the query string', async () => {
      const user = await register();

      const anonymous = await api('/api/notifications/stream');
      assert.equal(anonymous.status, 401);

      // The old contract. Answer with the migration instruction rather than a bare
      // 401 that looks like a broken login.
      const legacy = await api(`/api/notifications/stream?token=${encodeURIComponent(user.token)}`);
      assert.equal(legacy.status, 401);
      assert.match(legacy.body.error.message, /stream-ticket/);

      const bogusTicket = await api('/api/notifications/stream?ticket=not-a-real-ticket');
      assert.equal(bogusTicket.status, 401);

      const issued = await api('/api/notifications/stream-ticket', { token: user.token, method: 'POST' });
      assert.equal(issued.status, 200, issued.text);
      assert.match(issued.body.ticket, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.body.expiresIn, 30);

      const ticket = encodeURIComponent(issued.body.ticket);
      const stream = await fetch(`${baseUrl}/api/notifications/stream?ticket=${ticket}`);
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);

      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!/event: unread/.test(buffer)) {
          const chunk = await withTimeout(reader.read(), 5000, 'SSE read');
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }
      assert.match(buffer, /retry: 5000/, 'the server should hint a reconnect delay');
      assert.match(buffer, /event: unread/, 'the first frame should carry the unread count');

      // Single use: a ticket captured from a proxy log is already spent.
      const replay = await api(`/api/notifications/stream?ticket=${ticket}`);
      assert.equal(replay.status, 401);
    });
  });

  describe('google oauth start leg (H1)', () => {
    it('hands back a consent URL from POST and answers 405 on the old GET', async () => {
      const user = await register();
      const savedId = config.googleClientId;
      const savedSecret = config.googleClientSecret;
      const savedRedirect = config.googleRedirectUri;
      config.googleClientId = 'integration-client-id.apps.googleusercontent.com';
      config.googleClientSecret = 'integration-client-secret';
      config.googleRedirectUri = undefined;
      try {
        const started = await api('/api/calendar/google/start', { token: user.token, method: 'POST' });
        assert.equal(started.status, 200, started.text);
        assert.ok(started.body.expiresIn > 0, 'the client needs to know how long the state row lives');

        const url = new URL(started.body.url as string);
        assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.equal(url.searchParams.get('client_id'), config.googleClientId);
        assert.equal(url.searchParams.get('response_type'), 'code');
        // Without offline access there is no refresh token, and sync dies at the
        // first access-token expiry an hour later.
        assert.equal(url.searchParams.get('access_type'), 'offline');
        assert.equal(
          url.searchParams.get('scope'),
          'https://www.googleapis.com/auth/calendar.readonly',
          'least privilege: read-only, not full calendar access'
        );
        assert.match(url.searchParams.get('redirect_uri') ?? '', /\/api\/calendar\/google\/callback$/);

        // The callback is public by necessity, so the state row is the only thing
        // binding the returning browser to an account. It has to exist, be
        // unspent, and name the caller.
        const state = url.searchParams.get('state') ?? '';
        const row = prepare('SELECT user_id, used FROM oauth_states WHERE state = ?').get(state) as
          | { user_id: string; used: number }
          | undefined;
        assert.ok(row, 'the consent URL must carry a state that exists server-side');
        assert.equal(row.user_id, user.id);
        assert.equal(Number(row.used), 0);

        // The redirecting GET this replaced could never work: the route is behind
        // requireAuth, and the only thing that can follow a redirect to Google is
        // a top-level navigation, which sends no Authorization header. Say so
        // rather than 404ing an old client that still treats it as a link.
        const legacy = await api('/api/calendar/google/start', { token: user.token });
        assert.equal(legacy.status, 405, legacy.text);
        assert.equal(legacy.headers.get('allow'), 'POST');
        assert.equal(legacy.body.error.code, 'METHOD_NOT_ALLOWED');

        // And it is still header-authenticated like every other calendar route —
        // returning the URL instead of redirecting is what makes that possible.
        const anonymous = await api('/api/calendar/google/start', { method: 'POST' });
        assert.equal(anonymous.status, 401);
      } finally {
        config.googleClientId = savedId;
        config.googleClientSecret = savedSecret;
        config.googleRedirectUri = savedRedirect;
      }
    });

    it('refuses to mint a state row when Google is not configured', async () => {
      const savedId2 = config.googleClientId;
      const savedSecret2 = config.googleClientSecret;
      const savedRedirect2 = config.googleRedirectUri;
      config.googleClientId = undefined;
      config.googleClientSecret = undefined;
      config.googleRedirectUri = undefined;
      try {
        const user = await register();
        const res = await api('/api/calendar/google/start', { token: user.token, method: 'POST' });
      assert.equal(res.status, 422, res.text);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

        const status = await api('/api/calendar/status', { token: user.token });
        assert.equal(status.status, 200, status.text);
        assert.equal(status.body.googleConfigured, false);
        assert.equal(status.body.importExportEnabled, true, 'ICS import/export works without Google');
      } finally {
        config.googleClientId = savedId2;
        config.googleClientSecret = savedSecret2;
        config.googleRedirectUri = savedRedirect2;
      }
    });
  });

  describe('routing, error envelope and headers', () => {
    it('answers unknown routes with the standard envelope and security headers', async () => {
      const res = await api('/api/nope');
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
      assert.equal(typeof res.body.requestId, 'string');
      assert.ok(res.headers.get('x-request-id'));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      // Two middlewares used to set this with different values, so the effective
      // policy depended on mount order.
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.equal(res.headers.get('x-powered-by'), null, 'the framework should not advertise itself');
    });

    it('keeps the extract routes reachable behind the events prefix', async () => {
      const user = await register();
      // `/api/events/:id` will happily match `extract`, so mounting order decides
      // whether this endpoint exists at all. It answered 404 before the fix.
      const confirmed = await api('/api/events/extract/confirm', {
        token: user.token,
        body: {
          source: 'ai_text',
          events: [
            {
              title: 'Capstone demo',
              eventType: 'submission',
              dueAt: '2026-10-01T12:00:00+05:30',
              timezone: 'Asia/Kolkata'
            }
          ]
        }
      });
      assert.equal(confirmed.status, 201, confirmed.text);
      assert.equal(confirmed.body.events.length, 1);
      assert.equal(confirmed.body.events[0].confirmationStatus, 'user_confirmed');

      const extracted = await api('/api/events/extract', {
        token: user.token,
        body: { text: 'Assignment 2 is due on 2026-11-03 at 17:00', timezone: 'Asia/Kolkata' }
      });
      assert.equal(extracted.status, 200, extracted.text);
      assert.ok(Array.isArray(extracted.body.candidates));

      // And the sibling route still resolves ids normally.
      const unknown = await api('/api/events/00000000-0000-4000-8000-000000000000', { token: user.token });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error.code, 'NOT_FOUND');
    });

    it('reports a malformed or oversized body as the client error it is', async () => {
      // Both used to arrive as 500 INTERNAL_ERROR and were logged as unhandled
      // server faults, which buried the real ones.
      const malformed = await api('/api/events', {
        method: 'POST',
        raw: '{"title": ',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(malformed.status, 400, malformed.text);
      assert.equal(malformed.body.error.code, 'MALFORMED_BODY');

      const oversized = await api('/api/events', {
        method: 'POST',
        raw: JSON.stringify({ title: 'x'.repeat(1_200_000) }),
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(oversized.status, 413, oversized.text);
      assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
    });
  });

  describe('inbox webhook (H3)', () => {
    const form = (fields: Record<string, string>, token?: string): RequestOptions => {
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (token) headers['X-Inbox-Token'] = token;
      return { method: 'POST', raw: new URLSearchParams(fields).toString(), headers };
    };

    it('authenticates by header and resolves the account from the addressed token only', async () => {
      const user = await register();
      const tokenRes = await api('/api/user/profile/forwarding-token', { token: user.token });
      assert.equal(tokenRes.status, 200, tokenRes.text);
      const address = tokenRes.body.address as string;
      assert.match(address, /^deadline\+[a-f0-9]{16,64}@/);

      const payload = {
        to: address,
        from: 'registrar@university.test',
        subject: 'Assignment 3 due 2026-12-04 at 17:00',
        text: 'Submit through the portal.'
      };

      // The secret used to be accepted from the URL path and query string, where
      // proxies and access logs record it by default.
      const noToken = await api('/api/inbox/webhook', form(payload));
      assert.equal(noToken.status, 403);

      const inUrl = await api(`/api/inbox/webhook?token=${INBOX_SECRET}`, form(payload));
      assert.equal(inUrl.status, 403, 'a token in the query string must not authenticate');

      const inPath = await api(`/api/inbox/webhook/${INBOX_SECRET}`, form(payload));
      assert.equal(inPath.status, 404, 'the /webhook/:token route should no longer exist');

      const wrongToken = await api('/api/inbox/webhook', form(payload, 'wrong-secret'));
      assert.equal(wrongToken.status, 403);

      const accepted = await api('/api/inbox/webhook', form(payload, INBOX_SECRET));
      assert.equal(accepted.status, 202, accepted.text);
      assert.equal(accepted.body.ok, true);
      assert.equal(typeof accepted.body.savedCount, 'number');

      const titles = await notificationTitles(user);
      assert.ok(
        titles.some((title) => INBOX_NOTICE_TITLES.includes(title)),
        `the recipient should be told their forward was processed; got ${JSON.stringify(titles)}`
      );
    });

    it('resolves the account out of a display-name, multi-recipient To header', async () => {
      const user = await register();
      const tokenRes = await api('/api/user/profile/forwarding-token', { token: user.token });
      assert.equal(tokenRes.status, 200, tokenRes.text);
      const address = tokenRes.body.address as string;

      // What providers actually forward is the header, not a bare address.
      // `to.split('@')[0]` — the previous shape — produced a local part of
      // `"Priya Sharma" <deadline+ab12` and resolved to nobody, so every forward
      // from a real mail client was accepted with `unresolved-recipient` and
      // silently dropped. A forwarded message can also name several recipients.
      const accepted = await api(
        '/api/inbox/webhook',
        form(
          {
            to: `"Priya Sharma" <${address}>, registrar@university.test`,
            from: 'registrar@university.test',
            subject: 'Assignment 9 due 2026-12-11 at 17:00',
            text: 'Submit through the portal.'
          },
          INBOX_SECRET
        )
      );
      assert.equal(accepted.status, 202, accepted.text);
      assert.equal(accepted.body.ignored, undefined, 'a display-name To header must still resolve');
      const titles = await notificationTitles(user);
      assert.ok(
        titles.some((title) => INBOX_NOTICE_TITLES.includes(title)),
        `the resolved recipient should have been notified; got ${JSON.stringify(titles)}`
      );

      // A display name may itself contain an `@`, so the angle-bracket form has
      // to win over splitting the header on commas.
      const trickyName = await api(
        '/api/inbox/webhook',
        form(
          {
            to: `"reg@istrar" <${address}>`,
            subject: 'Quiz 2 due 2026-12-12 at 09:00',
            text: 'Bring a calculator.'
          },
          INBOX_SECRET
        )
      );
      assert.equal(trickyName.status, 202, trickyName.text);
      assert.equal(trickyName.body.ignored, undefined);

      // A header that names nobody we know is still accepted — the provider must
      // not retry it — but writes nothing.
      const unknown = await api(
        '/api/inbox/webhook',
        form({ to: '"Nobody" <deadline+00112233445566778899@example.test>' }, INBOX_SECRET)
      );
      assert.equal(unknown.status, 202);
      assert.equal(unknown.body.ignored, 'unresolved-recipient');
    });

    it('ignores a forged sender claiming to be a forwarding address', async () => {
      const victim = await register();
      const tokenRes = await api('/api/user/profile/forwarding-token', { token: victim.token });
      const victimAddress = tokenRes.body.address as string;

      // The attacker puts the victim's forwarding address in `From`, which is
      // trivially spoofable, and something else entirely in `To`. Recipients are
      // resolved from `To` alone.
      const spoofed = await api(
        '/api/inbox/webhook',
        form(
          {
            to: 'someone-else@example.test',
            from: victimAddress,
            subject: 'Fake deadline 2026-12-05 at 09:00',
            text: 'Injected.'
          },
          INBOX_SECRET
        )
      );
      assert.equal(spoofed.status, 202);
      assert.equal(spoofed.body.ignored, 'unresolved-recipient');

      const events = await api('/api/events', { token: victim.token });
      assert.equal(events.body.events.length, 0, 'a spoofed From must not write to the victim account');
      // Registration leaves a welcome notification, so assert on what is *absent*
      // rather than on an empty list.
      const titles = await notificationTitles(victim);
      assert.deepEqual(titles, [WELCOME_TITLE], 'the victim should have nothing but their welcome notice');
    });
  });

  describe('metrics and health', () => {
    it('requires auth and exposes a live queue read alongside the counters', async () => {
      const unauthenticated = await api('/api/metrics');
      assert.equal(unauthenticated.status, 401);

      const user = await register();
      const res = await api('/api/metrics', { token: user.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(typeof res.body.requestsTotal, 'number');
      assert.equal(typeof res.body.uptimeSeconds, 'number');

      // The counters reset on restart, so they cannot answer "how much is stuck
      // right now" — that is what the queue read is for.
      for (const key of ['pending', 'processing', 'failed', 'claimable']) {
        assert.equal(typeof res.body.outbox[key], 'number', `outbox.${key} should be a number`);
      }
      const oldest = res.body.outbox.oldestClaimableAgeSeconds;
      assert.ok(oldest === null || typeof oldest === 'number');
    });

    it('reports readiness and liveness without a token', async () => {
      const health = await api('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.ok, true);
      const readiness = await api('/api/health/readiness');
      assert.equal(readiness.status, 200, readiness.text);
      assert.equal(readiness.body.database, 'up');
    });
  });

  describe('outbox claiming honours backoff (C2, H7)', () => {
    it('does not claim a job before its next_retry_at, and does not burn its attempts', async () => {
      const user = await register();
      // Far enough out that the planner does not materialize anything itself, so
      // the only outbox rows for this event are the two seeded below.
      const event = await createEvent(user, {
        title: 'Backoff probe',
        dueAt: inFuture(60 * 86_400_000),
        timezone: 'UTC',
        reminders: [
          { offsetSeconds: 3600, channel: 'in_app' },
          { offsetSeconds: 7200, channel: 'in_app' }
        ]
      });
      assert.equal(
        countRows('SELECT COUNT(*) AS c FROM reminder_deliveries WHERE event_id = ?', event.id),
        0,
        'a deadline 60 days out is beyond the planner horizon'
      );

      const reminderIds = (
        prepare('SELECT id FROM reminders WHERE event_id = ? ORDER BY offset_seconds ASC').all(
          event.id
        ) as unknown as Array<{ id: string }>
      ).map((row) => row.id);
      assert.equal(reminderIds.length, 2);

      const seed = (reminderId: string, options: { scheduledAt: string; nextRetryAt?: string }): string => {
        const deliveryId = uuid();
        const outboxId = uuid();
        prepare(
          `INSERT INTO reminder_deliveries (id, reminder_id, event_id, user_id, scheduled_for, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).run(deliveryId, reminderId, event.id, user.id, options.scheduledAt, nowIso());
        prepare(
          `INSERT INTO notification_outbox
             (id, delivery_id, payload, status, attempts, max_attempts, scheduled_at, next_retry_at,
              idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`
        ).run(
          outboxId,
          deliveryId,
          JSON.stringify({
            deliveryId,
            eventId: event.id,
            userId: user.id,
            channel: 'in_app',
            offsetSeconds: 3600,
            scheduledFor: options.scheduledAt
          }),
          config.outboxMaxAttempts,
          options.scheduledAt,
          options.nextRetryAt ?? null,
          `reminder:${deliveryId}`,
          nowIso(),
          nowIso()
        );
        return outboxId;
      };

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const dueJob = seed(reminderIds[0], { scheduledAt: fiveMinutesAgo });
      const backedOffJob = seed(reminderIds[1], {
        scheduledAt: fiveMinutesAgo,
        nextRetryAt: new Date(Date.now() + 10 * 60_000).toISOString()
      });

      const depth = outboxQueueDepth();
      assert.ok(depth.pending >= 2, 'both seeded jobs are pending');
      assert.ok(depth.claimable >= 1, 'the due one is claimable');
      assert.ok(
        depth.oldestClaimableAgeSeconds !== null && depth.oldestClaimableAgeSeconds >= 290,
        `expected a backlog age near 300s, got ${depth.oldestClaimableAgeSeconds}`
      );

      await processOnce();

      const statusOf = (id: string): { status: string; attempts: number } =>
        prepare('SELECT status, attempts FROM notification_outbox WHERE id = ?').get(id) as {
          status: string;
          attempts: number;
        };

      const due = statusOf(dueJob);
      assert.equal(due.status, 'sent', 'a job past its scheduled time should be delivered');
      assert.equal(due.attempts, 1);

      // The bug: `next_retry_at` was missing from the claim predicate, so every
      // attempt was spent on consecutive 30s ticks and any outage longer than a
      // minute and a half dead-lettered every reminder due inside it.
      const backedOff = statusOf(backedOffJob);
      assert.equal(backedOff.status, 'pending', 'a backed-off job must not be claimed early');
      assert.equal(backedOff.attempts, 0, 'a backed-off job must not burn an attempt');

      // Delivery bookkeeping moves with the job, in the same transaction.
      assert.equal(
        countRows(
          `SELECT COUNT(*) AS c FROM reminder_deliveries WHERE event_id = ? AND status = 'sent'`,
          event.id
        ),
        1
      );
      const titles = await notificationTitles(user);
      assert.ok(
        titles.some((title) => title.includes('Backoff probe')),
        `the in-app reminder should have landed; got ${JSON.stringify(titles)}`
      );
    });

    it('folds a tick that arrives mid-cycle into a catch-up run instead of dropping it', async () => {
      const before = metrics.engineTicksCoalesced;

      // No timing games needed: `running` is set synchronously before the first
      // await, so the second call lands squarely inside the first cycle.
      const firstCycle = processOnce();
      const overlapping = await processOnce();
      assert.equal(overlapping, 0, 'an overlapping tick must not start a second cycle');
      await firstCycle;

      // This cycle awaits a network round trip per job, so it really can outlast
      // its 30s interval — and the old guard *dropped* the tick, making the queue
      // wait another full interval exactly when it was already behind. The
      // counter is what makes that degradation visible on /api/metrics rather
      // than only in a debug log nobody reads.
      assert.equal(metrics.engineTicksCoalesced, before + 1);
    });
  });
});

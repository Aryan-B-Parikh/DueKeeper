import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { handler, parseWith } from '../../middleware/validate';
import { prepare, inTransaction, queryAll, queryOne } from '../../db/database';
import { uuid } from '../../lib/ids';
import { nowIso } from '../../lib/time';
import { parseIcsCalendar, generateIcsCalendar } from '../../lib/ics';
import { createEvent, rescheduleExternalEvent } from '../events/events.service';
import { googleConfigured, buildAuthUrl, callbackUrl, exchangeCodeForTokens, refreshAccessToken, listCalendarEvents } from './google';
import { config } from '../../config/env';
import { NotFoundError, ValidationError, HttpError } from '../../lib/errors';
import { isValidCivilDate, zonedToUtcIso } from '../extract/dateUtils';

export const calendarRouter = Router();

/**
 * Turns a date-only value (`2026-08-24`) into an instant.
 *
 * All-day items carry no time, so somebody has to choose one. Midnight UTC — the
 * previous behaviour — lands on the wrong calendar day for every user behind
 * UTC, and for users ahead of it produces a deadline that has already passed by
 * the time they wake up. End of day on the user's own calendar is what "due that
 * day" actually means.
 */
function allDayToInstant(dateOnly: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!isValidCivilDate(year, month, day)) return null;
  return zonedToUtcIso(year, month, day, 23, 59, timezone);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }
});

// OAuth callbacks must be reachable by the browser without a Bearer header.
// They validate the `state` parameter (which encodes the initiating user)
// before contacting Google, and bind the resulting connection to that user.
async function googleCallback(req: Request, res: Response): Promise<void> {
  const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const redirectFail = `${config.webAppUrl}/dashboard/settings?google=error`;

  if (!googleConfigured() || !code || !stateValue) {
    res.redirect(302, redirectFail);
    return;
  }

  // Validate and consume state BEFORE exchanging the code — otherwise this
  // endpoint becomes an unauthenticated oracle for outbound token-exchange
  // requests, and a failed exchange leaves the state replayable.
  let stateUserId: string | null = null;
  try {
    inTransaction(() => {
      const stateRow = queryOne<{ user_id: string; used: 0 | 1; expires_at: string }>(
        'SELECT user_id, used, expires_at FROM oauth_states WHERE state = ?',
        stateValue
      );
      if (!stateRow || stateRow.used === 1 || new Date(stateRow.expires_at).getTime() < Date.now()) {
        throw new Error('Invalid OAuth state');
      }
      // If the callback happens to be authenticated, enforce binding to prevent
      // an attacker from using a leaked state to hijack a victim's account.
      const authedUser = (req as unknown as { user?: { id: string } }).user?.id;
      if (authedUser && authedUser !== stateRow.user_id) {
        throw new Error('OAuth state user mismatch');
      }
      prepare('UPDATE oauth_states SET used = 1 WHERE state = ?').run(stateValue);
      stateUserId = stateRow.user_id;
    });
  } catch {
    res.redirect(302, redirectFail);
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    prepare(
      `INSERT INTO calendar_connections
         (user_id, provider, encrypted_access_token, encrypted_refresh_token, token_expires_at, connected_at)
       VALUES (?, 'google', ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         encrypted_access_token = excluded.encrypted_access_token,
         encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, calendar_connections.encrypted_refresh_token),
         token_expires_at = excluded.token_expires_at,
         sync_token = NULL,
         connected_at = excluded.connected_at`
    ).run(
      stateUserId!,
      tokens.encryptedAccessToken,
      tokens.encryptedRefreshToken ?? null,
      new Date(Date.now() + tokens.expiresInSec * 1000 - 60_000).toISOString(),
      nowIso()
    );
    res.redirect(302, `${config.webAppUrl}/dashboard/settings?google=connected`);
  } catch {
    res.redirect(302, redirectFail);
  }
}

// Public, no auth: Google redirects the user's browser here.
calendarRouter.get('/google/callback', handler(googleCallback));
calendarRouter.get('/sync/callback', handler(googleCallback));

calendarRouter.use(requireAuth());

interface ConnectionRow {
  user_id: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  sync_token: string | null;
  last_synced_at: string | null;
}

calendarRouter.get(
  '/status',
  handler(async (req, res) => {
    const connection = queryOne<{ last_synced_at: string | null }>(
      'SELECT last_synced_at FROM calendar_connections WHERE user_id = ?',
      req.user!.id
    );
    res.json({
      googleConfigured: googleConfigured(),
      connected: Boolean(connection),
      lastSyncedAt: connection?.last_synced_at ?? null,
      importExportEnabled: true
    });
  })
);

calendarRouter.get(
  '/export.ics',
  handler(async (req, res) => {
    const rows = queryAll<{ id: string; title: string; due_at: string; description: string | null }>(
      `SELECT id, title, due_at, description FROM events
       WHERE user_id = ? AND status NOT IN ('cancelled') ORDER BY due_at ASC`,
      req.user!.id
    );
    const ics = generateIcsCalendar(
      rows.map((row) => ({ id: row.id, title: row.title, dueAt: row.due_at, description: row.description }))
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="duekeeper.ics"');
    res.send(ics);
  })
);

calendarRouter.post(
  '/import',
  upload.single('file'),
  handler(async (req, res) => {
    const raw =
      req.file?.buffer.toString('utf8') ?? (typeof req.body?.ics === 'string' ? req.body.ics : '');
    if (!raw.trim()) throw new ValidationError('Provide an .ics file upload or raw ics text');

    let parsed;
    try {
      parsed = parseIcsCalendar(raw, {
        // Floating times (no Z, no TZID) are local to whoever reads the
        // calendar, and an Outlook-style TZID this platform cannot resolve is
        // the same situation. Both used to be read as UTC, shifting the deadline
        // by the user's offset.
        defaultTimezone: req.user!.timezone,
        maxEvents: 200
      });
    } catch {
      throw new ValidationError('Could not parse the iCalendar file');
    }
    if (parsed.length === 0) {
      res.json({ imported: 0, skipped: 0 });
      return;
    }

    let imported = 0;
    let skipped = 0;
    for (const item of parsed.slice(0, 100)) {
      // An all-day item carries no time, so it is read as end of day on the
      // user's own calendar; `startUtcIso` for those is midnight UTC, which is
      // the previous day for anyone west of UTC.
      const dueAt =
        item.allDay && item.startDate
          ? allDayToInstant(item.startDate, req.user!.timezone)
          : item.startUtcIso;
      const title = item.title;
      if (!dueAt || !title) {
        skipped += 1;
        continue;
      }
      const duplicate = prepare(
        `SELECT id FROM external_events WHERE user_id = ? AND provider = 'ics' AND external_id = ?`
      ).get(req.user!.id, item.uid);
      if (duplicate) {
        skipped += 1;
        continue;
      }
      // One transaction per item: an event without its mapping row would be
      // re-imported as a duplicate on the next upload of the same file.
      inTransaction(() => {
        const event = createEvent(req.user!.id, {
          title: title.slice(0, 200),
          description: item.description ?? null,
          eventType: 'other',
          dueAt,
          // The parser resolves DTSTART to a real instant using its TZID or the
          // zone passed above; the user's own zone is what we store for display
          // and for local-date grouping.
          timezone: req.user!.timezone,
          reminders: [{ offsetSeconds: 86400, channel: 'in_app' }],
          source: 'ics_import'
        });
        prepare(
          `INSERT INTO external_events (id, user_id, provider, external_id, event_id, imported_at)
           VALUES (?, ?, 'ics', ?, ?, ?)`
        ).run(uuid(), req.user!.id, item.uid, event.id, nowIso());
      });
      imported += 1;
    }
    res.json({ imported, skipped });
  })
);

function requireGoogleConfigured(): void {
  if (!googleConfigured()) {
    throw new ValidationError('Google Calendar sync requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
}

/**
 * Starts the Google consent flow.
 *
 * This answers with a URL instead of redirecting, and it is a POST rather than a
 * GET. The redirecting `GET /google/start` it replaces could never work: it sits
 * behind `requireAuth`, which reads the bearer token from a request header, but
 * the only thing that can follow a redirect to Google's consent screen is a
 * top-level browser navigation — and a navigation sends no such header. The web
 * client rendered it as a plain link, so every attempt to connect a calendar
 * died on a 401 before Google was contacted. Fixing the callback (H1/H2) left
 * that half of the flow still broken.
 *
 * Handing the URL back and letting the client navigate keeps the authenticated
 * request header-authenticated and puts no credential in a URL — which the
 * obvious alternative, a single-use `?ticket=` on a public GET, would have done
 * for no gain in round trips. POST because the call mints a single-use state row.
 */
calendarRouter.post(
  '/google/start',
  handler(async (req, res) => {
    requireGoogleConfigured();
    const state = uuid();
    const expiresInSeconds = 10 * 60;
    prepare('INSERT INTO oauth_states (state, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)').run(
      state,
      req.user!.id,
      new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      nowIso()
    );
    res.json({ url: buildAuthUrl(callbackUrl(), state), expiresIn: expiresInSeconds });
  })
);

// A client still treating this as a navigable link deserves an explanation
// rather than a bare 404 from the route table.
calendarRouter.get(
  '/google/start',
  handler(async (_req, res) => {
    res.setHeader('Allow', 'POST');
    throw new HttpError(
      405,
      'METHOD_NOT_ALLOWED',
      'Use POST /api/calendar/google/start, which returns the consent URL to navigate to. The redirecting GET was unreachable: a browser navigation carries no Authorization header.'
    );
  })
);


async function getValidAccessToken(userId: string): Promise<string> {
  const connection = prepare('SELECT * FROM calendar_connections WHERE user_id = ?').get(userId) as
    | ConnectionRow
    | undefined;
  if (!connection?.encrypted_access_token) throw new NotFoundError('Google connection');

  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) {
    return connection.encrypted_access_token;
  }
  if (!connection.encrypted_refresh_token) {
    throw new ValidationError('Google token expired and no refresh token stored; reconnect required');
  }
  const refreshed = await refreshAccessToken(connection.encrypted_refresh_token);
  prepare(
    `UPDATE calendar_connections SET encrypted_access_token = ?, token_expires_at = ? WHERE user_id = ?`
  ).run(
    refreshed.encryptedAccessToken,
    new Date(Date.now() + refreshed.expiresInSec * 1000 - 60_000).toISOString(),
    userId
  );
  return refreshed.encryptedAccessToken;
}

const DEADLINE_KEYWORDS =
  /(exam|deadline|due|submit|submission|assignment|hackathon|interview|test|quiz|midterm|final|milestone|review)/i;

calendarRouter.post(
  '/google/sync',
  handler(async (req, res) => {
    requireGoogleConfigured();
    const accessToken = await getValidAccessToken(req.user!.id);
    const connection = queryOne<{ sync_token: string | null }>(
      'SELECT sync_token FROM calendar_connections WHERE user_id = ?',
      req.user!.id
    );
    if (!connection) throw new NotFoundError('Google connection');

    const result = await listCalendarEvents({ encryptedAccessToken: accessToken, syncToken: connection.sync_token ?? undefined });
    if (result.gone) {
      prepare(`UPDATE calendar_connections SET sync_token = NULL WHERE user_id = ?`).run(req.user!.id);
      const fresh = await listCalendarEvents({ encryptedAccessToken: accessToken });
      result.events = fresh.events;
      result.nextSyncToken = fresh.nextSyncToken;
    }

    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const userTimezone = req.user!.timezone;
    for (const gEvent of result.events) {
      if (!gEvent.id || !gEvent.summary || gEvent.status === 'cancelled') {
        skipped += 1;
        continue;
      }
      // An all-day event has a date and no time. Pinning it to midnight UTC put
      // the deadline on the previous day for anyone west of UTC and stripped the
      // day's worth of runway for everyone else, so it is read as end-of-day on
      // the user's own calendar instead.
      const startIso = gEvent.start?.dateTime
        ? gEvent.start.dateTime
        : gEvent.start?.date
          ? allDayToInstant(gEvent.start.date, userTimezone)
          : null;
      if (!startIso) {
        skipped += 1;
        continue;
      }
      if (!DEADLINE_KEYWORDS.test(gEvent.summary)) {
        skipped += 1;
        continue;
      }

      const existingMapping = queryOne<{ event_id: string }>(
        `SELECT event_id FROM external_events WHERE user_id = ? AND provider = 'google' AND external_id = ?`,
        req.user!.id,
        gEvent.id
      );

      if (existingMapping) {
        // Goes through the service so a moved deadline also gets its queued
        // reminders re-planned; the bare UPDATE this replaced left them pointing
        // at the old date.
        const changed = rescheduleExternalEvent(req.user!.id, existingMapping.event_id, {
          title: gEvent.summary.slice(0, 200),
          dueAt: startIso,
          description: gEvent.description?.slice(0, 2000) ?? null
        });
        if (changed) updated += 1;
        continue;
      }

      // Same transaction rule as the ICS importer: the event and the mapping row
      // that stops it being re-imported have to land together.
      inTransaction(() => {
        const event = createEvent(req.user!.id, {
          title: gEvent.summary!.slice(0, 200),
          description: gEvent.description?.slice(0, 2000) ?? null,
          eventType: 'other',
          dueAt: startIso,
          timezone: userTimezone,
          reminders: [{ offsetSeconds: 86400, channel: 'in_app' }],
          source: 'calendar'
        });
        prepare(
          `INSERT INTO external_events (id, user_id, provider, external_id, event_id, imported_at)
           VALUES (?, ?, 'google', ?, ?, ?)`
        ).run(uuid(), req.user!.id, gEvent.id, event.id, nowIso());
      });
      imported += 1;    }

    if (result.nextSyncToken) {
      prepare(`UPDATE calendar_connections SET sync_token = ?, last_synced_at = ? WHERE user_id = ?`).run(
        result.nextSyncToken,
        nowIso(),
        req.user!.id
      );
    } else {
      prepare(`UPDATE calendar_connections SET last_synced_at = ? WHERE user_id = ?`).run(nowIso(), req.user!.id);
    }

    res.json({ imported, updated, skipped, scanned: result.events.length });
  })
);

calendarRouter.delete(
  '/google',
  handler(async (req, res) => {
    prepare(`DELETE FROM external_events WHERE user_id = ? AND provider = 'google'`).run(req.user!.id);
    const deleted = prepare(`DELETE FROM calendar_connections WHERE user_id = ? AND provider = 'google'`).run(
      req.user!.id
    );
    res.json({ ok: true, wasConnected: deleted.changes > 0 });
  })
);

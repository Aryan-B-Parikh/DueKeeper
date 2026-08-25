const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:8080';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (!raw) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/**
 * Streams have to be closed by hand or the per-user connection cap (default 5)
 * closes the door on the checks that follow.
 */
async function closeStream(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* already closed */
  }
  // Give the server's 'close' handler a moment to release the subscription slot.
  await new Promise((r) => setTimeout(r, 100));
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

async function main() {
  console.log(`DueKeeper smoke suite against ${BASE}\n`);

  console.log('[health]');
  const health = await api('GET', '/api/health');
  ok('GET /api/health returns ok', health.status === 200 && health.json?.ok === true);
  const ready = await api('GET', '/api/health/readiness');
  ok('readiness reports database up', ready.status === 200 && ready.json?.database === 'up');

  console.log('\n[auth]');
  const email = `smoke_${Date.now()}@test.local`;
  const badReg = await api('POST', '/api/auth/register', { body: { email, password: 'short', displayName: 'X' } });
  ok('register rejects weak password (422)', badReg.status === 422 && badReg.json?.error?.code === 'VALIDATION_ERROR');

  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'Passw0rd!42', displayName: 'Smoke Tester' }
  });
  ok('register succeeds (201)', reg.status === 201 && reg.json?.accessToken);
  const token = reg.json.accessToken;
const mainRefresh = reg.json.refreshToken;

  const dup = await api('POST', '/api/auth/register', {
    body: { email, password: 'Passw0rd!42', displayName: 'Dup' }
  });
  ok('duplicate register rejected (409)', dup.status === 409);

  const badLogin = await api('POST', '/api/auth/login', { body: { email, password: 'WrongPass1' } });
  ok('wrong password rejected (401)', badLogin.status === 401);

  const login = await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!42' } });
  ok('login succeeds', login.status === 200 && login.json?.accessToken && login.json?.refreshToken);

  const noAuth = await api('GET', '/api/events');
  ok('events without token rejected (401)', noAuth.status === 401);
  const forged = await api('GET', '/api/events', { token: 'abc.def.ghi' });
  ok('forged token rejected (401)', forged.status === 401);

  const me = await api('GET', '/api/auth/me', { token });
  ok('auth/me returns profile', me.status === 200 && me.json?.user?.email === email);

  console.log('\n[profile]');
  const prof = await api('GET', '/api/user/profile', { token });
  ok('profile has forwarding address', /^deadline\+[a-f0-9]+@/.test(prof.json?.forwardingAddress ?? ''));

  const tzUpdate = await api('PUT', '/api/user/profile', {
    token,
    body: { timezone: 'Asia/Kolkata', notificationPrefs: { reminderEmails: false } }
  });
  ok('profile update changes timezone', tzUpdate.json?.user?.timezone === 'Asia/Kolkata');
  const badTz = await api('PUT', '/api/user/profile', { token, body: { timezone: 'Not/AZone!!' } });
  ok('invalid timezone rejected', badTz.status === 422);

  console.log('\n[events crud]');
  const ev = await api('POST', '/api/events', {
    token,
    body: {
      title: 'DBMS midterm',
      description: 'Chapters 1-5',
      eventType: 'exam',
      dueAt: isoIn(6 * 3600_000),
      timezone: 'Asia/Kolkata',
      reminders: [
        { offsetSeconds: 86400, channel: 'in_app' },
        { offsetSeconds: 7200, channel: 'in_app' }
      ]
    }
  });
  ok('create event (201)', ev.status === 201 && ev.json?.event?.id);
  ok('event status computed as upcoming/due_soon', ['upcoming', 'due_soon'].includes(ev.json?.event?.status));
  ok('event has 2 reminders', ev.json?.event?.reminders?.length === 2);
  const eventId = ev.json.event.id;

  const invalidEv = await api('POST', '/api/events', {
    token,
    body: { title: '', eventType: 'exam', dueAt: isoIn(3600_000), timezone: 'UTC' }
  });
  ok('empty title rejected (422)', invalidEv.status === 422);

  const badReminder = await api('POST', '/api/events', {
    token,
    body: {
      title: 'Bad reminder',
      eventType: 'other',
      dueAt: isoIn(3600_000),
      timezone: 'UTC',
      reminders: [{ offsetSeconds: 999999, channel: 'carrier_pigeon' }]
    }
  });
  ok('invalid reminder channel+offset rejected', badReminder.status === 422);

  // The datetime contract, which is a deliberate breaking change: a naive local
  // time used to be read in whatever zone the server process happened to run in,
  // which shifted every reminder for the deadline without telling anyone.
  const naiveDue = await api('POST', '/api/events', {
    token,
    body: { title: 'Naive time', eventType: 'other', dueAt: '2026-09-01T09:00:00', timezone: 'Asia/Kolkata' }
  });
  ok('dueAt without an explicit offset rejected (422)', naiveDue.status === 422);

  const impossibleDue = await api('POST', '/api/events', {
    token,
    body: { title: 'Feb 31st', eventType: 'other', dueAt: '2026-02-31T09:00:00+05:30', timezone: 'Asia/Kolkata' }
  });
  ok('impossible civil date rejected instead of rolled forward (422)', impossibleDue.status === 422);

  const offsetZone = await api('POST', '/api/events', {
    token,
    body: { title: 'Offset as zone', eventType: 'other', dueAt: isoIn(3600_000), timezone: '+05:30' }
  });
  ok('fixed offset refused as a timezone (422)', offsetZone.status === 422);

  const upd = await api('PUT', `/api/events/${eventId}`, {
    token,
    body: {
      title: 'DBMS midterm (moved)',
      description: 'Chapters 1-6',
      eventType: 'exam',
      dueAt: isoIn(2 * 24 * 3600_000),
      timezone: 'Asia/Kolkata',
      reminders: [{ offsetSeconds: 3600, channel: 'email' }]
    }
  });
  ok('update event replaces reminders', upd.status === 200 && upd.json?.event?.reminders?.length === 1);

  const otherList = await api('GET', `/api/events/${eventId}x`, { token });
  ok('unknown event id -> 404', otherList.status === 404);

  console.log('\n[pagination envelope]');
  const paged = await api('GET', '/api/events?limit=2&offset=0', { token });
  ok(
    'list answers with a page envelope beside the items',
    paged.status === 200 &&
      Array.isArray(paged.json?.events) &&
      paged.json.events.length <= 2 &&
      paged.json?.page?.limit === 2 &&
      paged.json?.page?.offset === 0 &&
      typeof paged.json?.page?.total === 'number' &&
      typeof paged.json?.page?.hasMore === 'boolean'
  );
  const clamped = await api('GET', '/api/events?limit=100000', { token });
  ok(
    'an oversized limit is clamped, not an error',
    clamped.status === 200 && clamped.json?.page?.limit > 0 && clamped.json.page.limit <= 1000
  );
  // Silently defaulting a malformed parameter hands the client a plausible-looking
  // wrong page, which is worse than a 422.
  const badLimit = await api('GET', '/api/events?limit=abc', { token });
  ok('malformed limit rejected (422)', badLimit.status === 422);
  const badOffset = await api('GET', '/api/events?offset=-5', { token });
  ok('negative offset rejected (422)', badOffset.status === 422);
  const badStatus = await api('GET', '/api/events?status=nonsense', { token });
  ok('unknown status filter rejected (422)', badStatus.status === 422);

  console.log('\n[status lifecycle]');
  const soon = await api('POST', '/api/events', {
    token,
    body: {
      title: 'Quiz tomorrow',
      eventType: 'exam',
      dueAt: isoIn(20 * 3600_000),
      timezone: 'UTC',
      reminders: []
    }
  });
  ok('due within 72h computed as due_soon', soon.json?.event?.status === 'due_soon');

  const past = await api('POST', '/api/events', {
    token,
    body: { title: 'Old task', eventType: 'other', dueAt: isoIn(-3600_000), timezone: 'UTC', reminders: [] }
  });
  ok('past event computed as overdue', past.json?.event?.status === 'overdue');
  const overdueId = past.json.event.id;

  const snooze = await api('POST', `/api/events/${overdueId}/snooze`, { token, body: { duration: '2h' } });
  ok('snooze shifts due date into future', snooze.status === 200 && new Date(snooze.json.event.dueAt).getTime() > Date.now());
  const badSnooze = await api('POST', `/api/events/${overdueId}/snooze`, { token, body: { duration: '-5m' } });
  ok('negative snooze rejected (422)', badSnooze.status === 422);

  const done = await api('POST', `/api/events/${soon.json.event.id}/done`, { token });
  ok('mark done sets terminal status', done.json?.event?.status === 'done');

  // Snoozing a finished deadline used to resurrect it and re-arm its reminders.
  const snoozeDone = await api('POST', `/api/events/${soon.json.event.id}/snooze`, {
    token,
    body: { duration: '2h' }
  });
  ok('snoozing a done event rejected (422)', snoozeDone.status === 422);

  console.log('\n[extraction]');
  const extract = await api('POST', '/api/events/extract', {
    token,
    body: { text: 'Final project submission deadline Sep 15 2026 23:59\nOS exam on 21/08/2026 at 10:30 AM' }
  });
  ok('text extraction returns candidates', extract.status === 200 && extract.json?.candidates?.length >= 1);
  const proj = extract.json.candidates.find((c) => /project/i.test(c.title));
  ok(
    'extracted project due 2026-09-15 23:59 IST -> 18:29 UTC',
    proj?.dueAt === '2026-09-15T18:29:00.000Z'
  );

  const confirm = await api('POST', '/api/events/extract/confirm', {
    token,
    body: {
      source: 'ai_text',
      events: [
        {
          title: proj.title,
          eventType: 'submission',
          dueAt: proj.dueAt,
          timezone: 'Asia/Kolkata'
        }
      ]
    }
  });
  ok('confirm persists extracted event as user_confirmed', confirm.status === 201 && confirm.json?.events?.[0]?.confirmationStatus === 'user_confirmed');

  const emptyExtract = await api('POST', '/api/events/extract', { token, body: {} });
  ok('extract with nothing provided rejected (422)', emptyExtract.status === 422);

  console.log('\n[ics import/export]');
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:ics-test-001@external',
    'DTSTART:20260901T100000Z',
    'SUMMARY:ICS imported deadline',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:ics-test-002@external',
    'DTSTART;TZID=Asia/Kolkata:20260902T093000',
    'SUMMARY:Tz-aware ICS event',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const form = new FormData();
  form.append('file', new Blob([icsContent], { type: 'text/calendar' }), 'cal.ics');
  const importRes = await fetch(`${BASE}/api/calendar/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const importJson = await importRes.json();
  ok('ics import creates events', importRes.status === 200 && importJson.imported === 2);

  const reImport = await fetch(`${BASE}/api/calendar/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: (() => {
      const f = new FormData();
      f.append('file', new Blob([icsContent], { type: 'text/calendar' }), 'cal.ics');
      return f;
    })()
  });
  const reJson = await reImport.json();
  ok('re-import deduplicates by uid', reJson.imported === 0 && reJson.skipped >= 2);

  const exportRes = await fetch(`${BASE}/api/calendar/export.ics`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const icsOut = await exportRes.text();
  ok(
    'export produces valid VCALENDAR containing our events',
    exportRes.status === 200 &&
      icsOut.includes('BEGIN:VCALENDAR') &&
      icsOut.includes('DBMS midterm') &&
      icsOut.includes('ICS imported deadline')
  );

  console.log('\n[notifications + outbox engine]');
  const reminderEvent = await api('POST', '/api/events', {
    token,
    body: {
      title: 'Fire alarm test',
      eventType: 'other',
      dueAt: isoIn(90_000),
      timezone: 'UTC',
      reminders: [{ offsetSeconds: 0, channel: 'in_app' }, { offsetSeconds: 0, channel: 'email' }]
    }
  });
  ok('near-due event created for engine test', reminderEvent.status === 201);
  console.log('  ... waiting 150s for planner+outbox cycles to deliver reminders');
  await new Promise((r) => setTimeout(r, 150_000));

  const notifs = await api('GET', '/api/notifications?unreadOnly=true', { token });
  const fireNotif = notifs.json.notifications.find((n) => /Fire alarm test/.test(n.title));
  ok('in-app reminder delivered via outbox', Boolean(fireNotif));

  const unreadCount = await api('GET', '/api/notifications/unread-count', { token });
  ok('unread count reflects delivered reminder', unreadCount.json.unreadCount >= 1);

  if (fireNotif) {
    await api('POST', `/api/notifications/${fireNotif.id}/read`, { token: token });
    const after = await api('GET', '/api/notifications/unread-count', { token });
    ok('mark-read decrements unread count', after.json.unreadCount === notifs.json.unreadCount - 1);
  }

  const readAll = await api('POST', '/api/notifications/read-all', { token });
  ok('read-all succeeds', readAll.status === 200);

  console.log('\n[inbox webhook security]');
  const inboxForm = () =>
    new URLSearchParams({ to: 'deadline+00112233445566778899@example.test', subject: 'x' }).toString();
  const inboxHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

  const inboxOff = await fetch(`${BASE}/api/inbox/webhook`, {
    method: 'POST',
    headers: { ...inboxHeaders, 'X-Inbox-Token': 'whatever' },
    body: inboxForm()
  });
  ok(
    'inbox webhook rejects an unknown secret (404 unconfigured, 403 configured)',
    inboxOff.status === 404 || inboxOff.status === 403
  );

  // The secret is header-only now. A token in a URL is captured by proxy and
  // web-server access logs, browser history and Referer headers, so the `?token=`
  // and `/webhook/:token` forms were removed rather than kept as a fallback.
  const inboxQueryToken = await fetch(`${BASE}/api/inbox/webhook?token=whatever`, {
    method: 'POST',
    headers: inboxHeaders,
    body: inboxForm()
  });
  ok(
    'query-string webhook secret no longer authenticates (404/403)',
    inboxQueryToken.status === 404 || inboxQueryToken.status === 403
  );
  const inboxPathToken = await fetch(`${BASE}/api/inbox/webhook/whatever`, {
    method: 'POST',
    headers: inboxHeaders,
    body: inboxForm()
  });
  ok('the /webhook/:token path form is gone (404)', inboxPathToken.status === 404);

  console.log('\n[sse live stream]');
  // A query-string access token is no longer accepted: it is long-lived and
  // replayable, and stream URLs land in proxy logs, history and Referer headers.
  const legacyStream = await fetch(`${BASE}/api/notifications/stream?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' }
  });
  ok('SSE refuses a query-string access token (401)', legacyStream.status === 401);
  await closeStream(legacyStream);

  const ticketRes = await api('POST', '/api/notifications/stream-ticket', { token });
  ok(
    'stream ticket minted over the header-authenticated path',
    ticketRes.status === 200 &&
      typeof ticketRes.json?.ticket === 'string' &&
      ticketRes.json.ticket.length >= 40 &&
      ticketRes.json?.expiresIn > 0
  );
  const ticket = ticketRes.json?.ticket ?? '';

  const streamCtrl = new AbortController();
  const sseRes = await fetch(`${BASE}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`, {
    signal: streamCtrl.signal,
    headers: { Accept: 'text/event-stream' }
  });
  ok(
    'SSE endpoint responds as event-stream',
    sseRes.status === 200 && (sseRes.headers.get('content-type') ?? '').includes('text/event-stream')
  );
  if (sseRes.status === 200) {
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value ?? new Uint8Array());
    ok('SSE pushes initial unread event', chunk.includes('event: unread') && chunk.includes('count'));
    streamCtrl.abort();
  } else {
    streamCtrl.abort();
  }
  await new Promise((r) => setTimeout(r, 100));

  // Single use is the property that makes a ticket safe to put in a URL at all:
  // one captured from an access log is already spent.
  const replayed = await fetch(`${BASE}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Accept: 'text/event-stream' }
  });
  ok('a spent ticket cannot be replayed (401)', replayed.status === 401);
  await closeStream(replayed);

  const sseDenied = await fetch(`${BASE}/api/notifications/stream?ticket=forged-ticket-value`);
  ok('SSE rejects a forged ticket', sseDenied.status === 401);
  await closeStream(sseDenied);

  // Non-browser clients keep the header path, which runs the full revocation check.
  const sseHeaderPath = await fetch(`${BASE}/api/notifications/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }
  });
  ok(
    'SSE also accepts an Authorization header for non-browser clients',
    sseHeaderPath.status === 200 &&
      (sseHeaderPath.headers.get('content-type') ?? '').includes('text/event-stream')
  );
  await closeStream(sseHeaderPath);

  console.log('\n[google oauth start leg]');
  const calStatus = await api('GET', '/api/calendar/status', { token });
  ok(
    'calendar status reports what is configured',
    calStatus.status === 200 &&
      typeof calStatus.json?.googleConfigured === 'boolean' &&
      calStatus.json?.importExportEnabled === true
  );

  // The start leg is a POST that returns the consent URL. The redirecting GET it
  // replaced could never work: it sits behind header auth, and the only thing
  // that can follow a redirect to Google is a navigation, which sends no header.
  const startGet = await fetch(`${BASE}/api/calendar/google/start`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual'
  });
  ok(
    'GET on the start leg answers 405 with Allow: POST',
    startGet.status === 405 && (startGet.headers.get('allow') ?? '').toUpperCase().includes('POST')
  );

  const startPost = await api('POST', '/api/calendar/google/start', { token });
  if (calStatus.json?.googleConfigured) {
    let startUrl = null;
    try {
      startUrl = new URL(startPost.json?.url ?? '');
    } catch {
      startUrl = null;
    }
    ok(
      'start returns a Google consent URL carrying state',
      startPost.status === 200 &&
        startUrl?.origin === 'https://accounts.google.com' &&
        startUrl.searchParams.get('response_type') === 'code' &&
        startUrl.searchParams.get('access_type') === 'offline' &&
        Boolean(startUrl.searchParams.get('state')) &&
        startPost.json?.expiresIn > 0
    );
  } else {
    ok(
      'start reports 422 while Google is unconfigured',
      startPost.status === 422 && startPost.json?.error?.code === 'VALIDATION_ERROR'
    );
  }
  const startNoAuth = await fetch(`${BASE}/api/calendar/google/start`, { method: 'POST' });
  ok('start leg requires authentication (401)', startNoAuth.status === 401);

  console.log('\n[account management]');
  const amEmail = `am_${Date.now()}@test.local`;
  const amReg = await api('POST', '/api/auth/register', {
    body: { email: amEmail, password: 'Passw0rd!42', displayName: 'Account Mgmt' }
  });
  const amToken = amReg.json?.accessToken;
  ok('account-mgmt user registered', amReg.status === 201 && Boolean(amToken));

  const wrongCurrent = await api('POST', '/api/user/password', {
    token: amToken,
    body: { currentPassword: 'WrongOld1', newPassword: 'NewPass0rd!9' }
  });
  ok('password change with wrong current rejected (401)', wrongCurrent.status === 401);

  const changed = await api('POST', '/api/user/password', {
    token: amToken,
    body: { currentPassword: 'Passw0rd!42', newPassword: 'NewPass0rd!9' }
  });
  ok('password change succeeds', changed.status === 200 && changed.json?.sessionsRevoked === true);

  const meAfterPw = await api('GET', '/api/auth/me', { token: amToken });
  ok('password change revokes existing sessions (401)', meAfterPw.status === 401);

  const oldLogin = await api('POST', '/api/auth/login', { body: { email: amEmail, password: 'Passw0rd!42' } });
  ok('old password no longer works', oldLogin.status === 401);
  const newLogin = await api('POST', '/api/auth/login', { body: { email: amEmail, password: 'NewPass0rd!9' } });
  ok('new password works', newLogin.status === 200);
  const amToken2 = newLogin.json?.accessToken;
  ok('fresh token issued after rotation', Boolean(amToken2));

  const samePw = await api('POST', '/api/user/password', {
    token: amToken2,
    body: { currentPassword: 'NewPass0rd!9', newPassword: 'NewPass0rd!9' }
  });
  ok('same-password change rejected (422)', samePw.status === 422);

  await api('POST', '/api/events', {
    token: amToken2,
    body: { title: 'Export probe', eventType: 'other', dueAt: isoIn(86400_000), timezone: 'UTC', reminders: [] }
  });

  const accountExportRes = await fetch(`${BASE}/api/user/export`, { headers: { Authorization: `Bearer ${amToken2}` } });
  const exportJson = await accountExportRes.json().catch(() => null);
  ok(
    'data export returns profile + events',
    accountExportRes.status === 200 &&
      exportJson?.profile?.email === amEmail &&
      Array.isArray(exportJson?.events) &&
      exportJson.events.some((e) => e.title === 'Export probe')
  );

  const delAcc = await api('DELETE', '/api/user/profile', { token: amToken2 });
  ok('account deletion returns 204', delAcc.status === 204);
  const meAfterDelete = await api('GET', '/api/auth/me', { token: amToken2 });
  ok('deleted account fails auth/me (401)', meAfterDelete.status === 401);
  const relLogin = await api('POST', '/api/auth/login', { body: { email: amEmail, password: 'NewPass0rd!9' } });
  ok('deleted account cannot log in', relLogin.status === 401);

  console.log('\n[session revocation]');
  const srEmail = `sr_${Date.now()}@test.local`;
  const srReg = await api('POST', '/api/auth/register', {
    body: { email: srEmail, password: 'Passw0rd!42', displayName: 'Session Revoker' }
  });
  const srA = srReg.json?.accessToken;
  const srLoginB = await api('POST', '/api/auth/login', { body: { email: srEmail, password: 'Passw0rd!42' } });
  const srB = srLoginB.json?.accessToken;
  ok('two concurrent sessions created', Boolean(srA) && Boolean(srB));

  const revoked = await api('POST', '/api/user/sessions/revoke-all', { token: srA });
  ok('revoke-all succeeds', revoked.status === 200 && revoked.json?.ok === true);
  ok('session A dead after revoke-all', (await api('GET', '/api/auth/me', { token: srA })).status === 401);
  ok('session B dead after revoke-all', (await api('GET', '/api/auth/me', { token: srB })).status === 401);
  const srC = (await api('POST', '/api/auth/login', { body: { email: srEmail, password: 'Passw0rd!42' } })).json?.accessToken;
  ok('re-login works after revocation', Boolean(srC) && (await api('GET', '/api/auth/me', { token: srC })).status === 200);

  console.log('\n[web push endpoints]');
  const pkRes = await api('GET', '/api/user/push/public-key', { token });
  ok(
    'vapid public key available and well-formed',
    pkRes.status === 200 &&
      pkRes.json?.available === true &&
      typeof pkRes.json?.publicKey === 'string' &&
      pkRes.json.publicKey.length >= 40
  );

  const fakeEndpoint = `https://push.test/devices/${Date.now()}`;
  const subRes = await api('POST', '/api/user/push/subscribe', {
    token,
    body: {
      endpoint: fakeEndpoint,
      keys: {
        p256dh: Buffer.alloc(65, 4).toString('base64url'),
        auth: Buffer.alloc(16, 8).toString('base64url')
      }
    }
  });
  ok('push subscription accepted (201)', subRes.status === 201);

  const statusRes = await api('GET', '/api/user/push/status', { token });
  ok('status reports at least one subscribed device', statusRes.json?.subscribedDevices >= 1);

  const testPush = await api('POST', '/api/user/push/test', { token });
  ok(
    'test push returns delivery counters for both channels',
    testPush.status === 200 && typeof testPush.json?.sent === 'number' && typeof testPush.json?.expoSent === 'number'
  );

  console.log('\n[expo push (mobile) endpoints]');
  const expoSub = await api('POST', '/api/user/push/expo', {
    token,
    body: { token: 'ExponentPushToken[test1234567890]' }
  });
  ok('expo push token registered (201)', expoSub.status === 201);

  const statusAfterExpo = await api('GET', '/api/user/push/status', { token });
  ok('status counts expo devices', statusAfterExpo.json?.expoDevices >= 1);

  const expoReSub = await api('POST', '/api/user/push/expo', {
    token,
    body: { token: 'ExponentPushToken[test1234567890]' }
  });
  const dedupeStatus = await api('GET', '/api/user/push/status', { token });
  ok('duplicate expo token upserts instead of duplicating', expoReSub.status === 201 && dedupeStatus.json?.expoDevices === 1);

  const expoUnsub = await api('DELETE', '/api/user/push/expo', {
    token,
    body: { token: 'ExponentPushToken[test1234567890]' }
  });
  ok('expo unsubscribe removes device', expoUnsub.status === 200 && expoUnsub.json?.ok === true);

  const unsubRes = await api('POST', '/api/user/push/unsubscribe', { token, body: { endpoint: fakeEndpoint } });
  ok('unsubscribe removes device', unsubRes.status === 200 && unsubRes.json?.ok === true);

  const badSub = await api('POST', '/api/user/push/subscribe', { token, body: { endpoint: 'not-a-url' } });
  ok('malformed subscription rejected (422)', badSub.status === 422);

  console.log('\n[login throttling]');
  const rlEmail = `rl_${Date.now()}@test.local`;
  await api('POST', '/api/auth/register', {
    body: { email: rlEmail, password: 'Passw0rd!42', displayName: 'Throttle Me' }
  });
  let saw429 = false;
  let retryAfter = null;
  let retryAfterDetail = null;
  for (let i = 0; i < 12; i += 1) {
    const attempt = await api('POST', '/api/auth/login', { body: { email: rlEmail, password: 'DefinitelyWrong1' } });
    if (attempt.status === 429) {
      saw429 = true;
      retryAfter = attempt.headers.get('retry-after');
      retryAfterDetail = attempt.json?.error?.details?.retryAfterSeconds ?? null;
      break;
    }
  }
  ok('repeated failed logins hit 429 rate limit', saw429);
  // Without this the client guesses, and an early retry only spends more budget
  // against a fixed window.
  ok(
    '429 carries Retry-After and repeats it in the error details',
    Number(retryAfter) > 0 && Number(retryAfterDetail) === Number(retryAfter),
    `header=${retryAfter} details=${retryAfterDetail}`
  );

  console.log('\n[refresh token rotation + theft detection]');
  const rtEmail = `rt_${Date.now()}@test.local`;
  const rtReg = await api('POST', '/api/auth/register', {
    body: { email: rtEmail, password: 'Passw0rd!42', displayName: 'Rotation' }
  });
  ok('register returns token pair too', Boolean(rtReg.json?.accessToken && rtReg.json?.refreshToken));
  const rtLogin = await api('POST', '/api/auth/login', {
    body: { email: rtEmail, password: 'Passw0rd!42' }
  });
  ok('login returns token pair', Boolean(rtLogin.json?.accessToken && rtLogin.json?.refreshToken));

  const rot1 = await api('POST', '/api/auth/refresh', { body: { refreshToken: rtLogin.json.refreshToken } });
  ok('refresh rotates to a new pair', rot1.status === 200 && Boolean(rot1.json?.accessToken && rot1.json?.refreshToken));

  const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: rtLogin.json.refreshToken } });
  ok('reusing a rotated refresh token is rejected (401)', reuse.status === 401);

  const afterTheft = await api('POST', '/api/auth/refresh', { body: { refreshToken: rot1.json.refreshToken } });
  ok('theft detection revokes the whole family (child token also dead)', afterTheft.status === 401);

  const reAuth = await api('POST', '/api/auth/login', { body: { email: rtEmail, password: 'Passw0rd!42' } });
  const logoutRes = await api('POST', '/api/auth/logout', { body: { refreshToken: reAuth.json.refreshToken } });
  ok('logout revokes the refresh token', logoutRes.status === 204);
  const postLogout = await api('POST', '/api/auth/refresh', { body: { refreshToken: reAuth.json.refreshToken } });
  ok('logged-out refresh token cannot be reused', postLogout.status === 401);

  console.log('\n[metrics endpoint]');
  const metricsNoAuth = await fetch(`${BASE}/api/metrics`);
  ok('metrics requires auth (401)', metricsNoAuth.status === 401);
  const metricsRes = await api('GET', '/api/metrics', { token });
  ok(
    'metrics exposes counters',
    metricsRes.status === 200 &&
      metricsRes.json?.requestsTotal > 0 &&
      typeof metricsRes.json?.uptimeSeconds === 'number' &&
      typeof metricsRes.json?.memoryMb === 'number'
  );
  // Counters reset on restart, so they cannot say what is stuck *now* — the live
  // queue read is what an alert on a falling-behind worker has to watch.
  ok(
    'metrics includes a live outbox gauge and the engine counters',
    typeof metricsRes.json?.outbox?.pending === 'number' &&
      typeof metricsRes.json?.outbox?.claimable === 'number' &&
      typeof metricsRes.json?.outbox?.oldestClaimableAgeSeconds !== 'undefined' &&
      typeof metricsRes.json?.outboxDeadLettered === 'number' &&
      typeof metricsRes.json?.engineTicksCoalesced === 'number' &&
      typeof metricsRes.json?.unhandledErrors === 'number'
  );

  console.log('\n[cleanup + ownership]');
  const del = await api('DELETE', `/api/events/${eventId}`, { token });
  ok('delete own event (204)', del.status === 204);
  const delAgain = await api('DELETE', `/api/events/${eventId}`, { token });
  ok('deleting again -> 404', delAgain.status === 404);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke runner crashed:', err);
  process.exit(1);
});

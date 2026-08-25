# API Reference

Base URL (dev): `http://localhost:8080`
All bodies are JSON unless noted. Authentication: `Authorization: Bearer <jwt>` on every route except `/api/health/*`, `/api/calendar/google/callback` and `/api/inbox/webhook` (the last one authenticates with a shared secret in a request header instead).

## Error envelope

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": { "title": "Title is required" } },
  "requestId": "9f3ac2b1"
}
```

| Status | Code | When |
|---|---|---|
| 400 | BAD_REQUEST | Malformed identifiers |
| 400 | MALFORMED_BODY | Request body is not parseable JSON |
| 401 | UNAUTHORIZED | Missing/invalid/expired token, or a session revoked by a password change |
| 403 | FORBIDDEN | Webhook token mismatch |
| 404 | NOT_FOUND | Unknown resource or disabled feature |
| 405 | METHOD_NOT_ALLOWED | Right path, wrong verb (see `Allow`) — currently only `GET /api/calendar/google/start` |
| 409 | CONFLICT | Duplicate email |
| 413 | PAYLOAD_TOO_LARGE | Upload or JSON body over the size cap |
| 415 | UNSUPPORTED_MEDIA_TYPE | Bad image format or unsupported request encoding |
| 422 | VALIDATION_ERROR | Schema validation failed, including bad `limit`/`offset`/`status` |
| 429 | RATE_LIMITED | A rate limit was hit (login, register, extraction, webhook, SSE) |
| 502 | EXTERNAL_SERVICE_ERROR | Gemini unreachable/invalid |

Every `429` carries a `Retry-After` header in seconds, and repeats the same number
in `error.details.retryAfterSeconds`. Wait that long before retrying rather than
guessing — the limiter is a fixed window, so an early retry only spends budget.

### Pagination

`GET /api/events` and `GET /api/notifications` take `?limit=&offset=` and answer with
a `page` object beside the items:

```json
{ "events": [], "page": { "limit": 50, "offset": 0, "total": 137, "hasMore": true } }
```

`limit` defaults to 50, **clamped** to `MAX_LIST_PAGE_SIZE` (100) — not an error. Malformed/negative `limit`/`offset` or unknown `status` → `422` (no silent fallback to default, which would hide a client bug behind a plausible wrong page).

## Health and metrics

- `GET /api/health` → `{ ok, name, version, uptimeSeconds }`
- `GET /api/health/liveness` → `{ ok: true }` (always)
- `GET /api/health/readiness` → `{ ok, database: "up" }` or 503 `{ ok:false, database:"down" }`
- `GET /api/metrics` (authenticated) → process counters plus a live queue read:
  `{ requestsTotal, responses5xx, authFailures, remindersSent, remindersFailed,
  pushesSent, pushesFailed, outboxReclaimed, outboxDeadLettered, deliveriesReconciled,
  engineTicksCoalesced, unhandledErrors, uptimeSeconds, memoryMb,
  outbox: { pending, processing, failed, claimable, oldestClaimableAgeSeconds } }`.
  The counters reset on restart, so they cannot say how much is stuck *now* — that is
  what `outbox` is for. Alert on `outboxDeadLettered` (every one is a reminder a user
  never received), on `outbox.oldestClaimableAgeSeconds` climbing (the worker is
  falling behind while there is still time to act), and on `unhandledErrors` at all
  (each is a bug that escaped every `try`). `engineTicksCoalesced` counts ticks that
  arrived mid-cycle and were folded into a catch-up run instead of being dropped;
  steady growth means a cycle routinely outlasts its interval.

## Auth

Access tokens are short-lived JWTs (default **15 min**); refresh tokens are opaque random strings (default **30 days**) stored hashed server-side and **rotated on every use with reuse detection** — presenting a rotated token revokes the entire family.

- `POST /api/auth/register` `{ email, password (8+ chars, letter+number), displayName }` → `201 { accessToken, refreshToken, user }`. Duplicate email → `409`. Rate-limited per IP.
- `POST /api/auth/login` `{ email, password }` → `{ accessToken, refreshToken, user }`. Wrong credentials → `401`; throttled to 10/15min per email+IP.
- `POST /api/auth/refresh` `{ refreshToken }` → `{ accessToken, refreshToken }` (rotation). Reuse of an already-rotated token is treated as theft: the whole family is revoked → `401`.
- `POST /api/auth/logout` `{ refreshToken }` → `204`, revokes that refresh token.
- `GET /api/auth/me` → `{ user }`

`user = { id, email, displayName, timezone, notificationPrefs, createdAt }`

## Profile

- `GET /api/user/profile` → `{ user, forwardingAddress: "deadline+<token>@<domain>", inboxConfigured }`
- `PUT /api/user/profile` `{ displayName?, timezone? (IANA), notificationPrefs? { reminderEmails?, dueSoonAlerts? } }`
- `GET /api/user/profile/forwarding-token` → `{ forwardingToken, address }`
- `POST /api/user/password` `{ currentPassword, newPassword (8+ chars, letter+number) }` → `{ ok, sessionsRevoked: true }`. Wrong current → 401; identical new → 422. Bumps the account's token version — **every existing session is invalidated**.
- `POST /api/user/sessions/revoke-all` → `{ ok }` — invalidates every token for the account (sign out everywhere).
- `GET /api/user/export` → JSON attachment (`duekeeper-export.json`) containing profile, all events with reminders, and notifications.
- `DELETE /api/user/profile` → `204`; cascading wipe of every deadline, reminder, delivery, notification and calendar link for the account.

### Browser push (Web Push / VAPID)

- `GET /api/user/push/status` → `{ available, subscribedDevices, expoDevices }`
- `GET /api/user/push/public-key` → `{ available, publicKey }` — base64url P-256 application server key
- `POST /api/user/push/subscribe` `{ endpoint, keys: { p256dh, auth } }` → `201`, upserted per endpoint
- `POST /api/user/push/unsubscribe` `{ endpoint }` → `{ ok }`
- `POST /api/user/push/expo` `{ token: "ExponentPushToken[…]" }` → `201`, upserted per token (mobile)
- `DELETE /api/user/push/expo` `{ token }` → `{ ok }`
- `POST /api/user/push/test` → `{ sent, removed, expoSent, expoRemoved }` — sends an encrypted
  test notification to every registered web device and a push to every Expo device;
  endpoints answering 404/410 are pruned automatically

Registering a device is one transaction: the ownership check, the per-account device
cap and the upsert cannot interleave, and the ownership rule is repeated in the
`ON CONFLICT` clause so a token already registered to another account cannot be
taken over in the gap between check and write. A device already registered to a
different account → `422`; exceeding `PUSH_SUBSCRIPTIONS_PER_USER` → `422`.

## Events

- `GET /api/events[?status=active|upcoming|due_soon|overdue|done|cancelled|all][&limit=50][&offset=0]`
  → `{ events: Event[], page }` ordered by `dueAt`. An unknown `status` → `422`.
- `GET /api/events/:id` → `{ event }`
- `POST /api/events`
  ```json
  {
    "title": "DBMS midterm",
    "description": "Chapters 1-6",
    "eventType": "exam",
    "dueAt": "2026-09-01T05:30:00.000Z",
    "timezone": "Asia/Kolkata",
    "reminders": [{ "offsetSeconds": 86400, "channel": "in_app" }]
  }
  ```
  → `201 { event }`. Reminders: 0–10 items, `offsetSeconds ∈ [0, 604800]`, channel `email|in_app`.

  `dueAt` **must carry an explicit UTC offset** (`Z` or `±HH:MM`). A naive
  `2026-09-01T09:00:00` is rejected with `422` instead of being read in whatever
  zone the server happens to run in, which silently shifted every reminder for the
  deadline. Impossible civil dates (`2026-02-31T09:00:00+05:30`) are rejected too
  rather than rolled forward the way `Date.parse` would. `timezone` must be an IANA
  zone name; a fixed offset like `+05:30` is refused because it cannot answer the
  DST questions the planner asks of it.
- `PUT /api/events/:id` — same body; replaces reminders and re-plans deliveries.
- `DELETE /api/events/:id` → `204`
- `POST /api/events/:id/done` → `{ event }` (status `done`, pending reminders cancelled — both the delivery rows and their queued outbox jobs)
- `POST /api/events/:id/cancel` → `{ event }` (status `cancelled`, pending reminders cancelled the same way)
- `POST /api/events/:id/snooze` `{ "duration": "30m" | "2h" | "1d" }` — shifts the due
  date (from now if already overdue) and re-plans reminders. Bounded to `1m … 30d`:
  zero, negative and absurd values (`0m`, `-30m`, `9999d`) are `422`, not an
  `Invalid Date`. Snoozing an event that is already `done` or `cancelled` is `422` —
  it used to resurrect the deadline and re-arm its reminders.

Event shape:

```json
{
  "id": "uuid", "title": "...", "description": null,
  "eventType": "exam|submission|hackathon|other",
  "dueAt": "ISO UTC", "timezone": "IANA",
  "source": "manual|ai_text|ai_screenshot|email|calendar|ics_import",
  "aiConfidence": 0.75, "confirmationStatus": "user_confirmed|auto_saved",
  "status": "upcoming|due_soon|overdue|done|cancelled",
  "reminders": [{ "id": "…", "offsetSeconds": 3600, "channel": "in_app", "enabled": true }],
  "createdAt": "…", "updatedAt": "…"
}
```

Status is computed live from `dueAt` (`overdue` past due, `due_soon` within 72h) unless terminal.

## Extraction

- `POST /api/events/extract`
  - JSON `{ "text": "…", "timezone"?: "Asia/Kolkata" }`, or
  - multipart field `screenshot` (PNG/JPEG/WebP ≤10MB) + optional `text`, `timezone`.
  → `{ engine: "gemini"|"heuristic", candidates: Candidate[] }`; screenshot without a configured key → `422 EXTRACTOR_UNAVAILABLE`.
  Rate limit: 10/hour/user → `429`.

  ```json
  { "id": "c0", "title": "Final project submission", "eventType": "submission",
    "dueAt": "2026-09-15T18:29:00.000Z", "timezone": "Asia/Kolkata",
    "confidence": 0.75, "needsClarification": false }
  ```

- `POST /api/events/extract/confirm` `{ source: "ai_text"|"ai_screenshot", events: [{ title, eventType, dueAt, timezone }] }` → `201 { events }` persisted as `user_confirmed` (≤20 per call).

## Notifications

- `GET /api/notifications[?unreadOnly=true][&limit=50][&offset=0]` → `{ notifications, unreadCount, page }`.
  `unreadCount` is always the account-wide unread total, not the count within the page.
- `GET /api/notifications/unread-count` → `{ unreadCount }`
- `POST /api/notifications/:id/read` → `{ ok }`
- `POST /api/notifications/read-all` → `{ ok }`

Notification: `{ id, eventId|null, type: reminder|system|info|warning, title, body, read, createdAt }`

### Live stream (SSE)

- `POST /api/notifications/stream-ticket` → `{ ticket, expiresIn }`. Requires the
  normal `Authorization: Bearer` header. The ticket is single-use, valid for 30 s, and
  carries the account’s `token_version` at mint time — a ticket minted just before
  `POST /api/user/password` or `POST /api/user/sessions/revoke-all` is rejected on
  consume, so the 30s window no longer outlives a revoke.
- `GET /api/notifications/stream?ticket=<ticket>` → `text/event-stream`.
  Non-browser clients may instead send `Authorization: Bearer <accessToken>` and skip
  the ticket; that path runs the same revocation checks as every other authenticated
  route, so a session ended by a password change or sign-out-everywhere cannot open a
  stream. `?token=<jwt>` is **no longer accepted** (401 with an explanatory
  message): the access token is long-lived and replayable, and stream URLs end up in
  proxy logs, browser history and `Referer`. Events:
  - `unread` — `{ count }`, sent on connect and whenever unread state changes
  - `notification` — full notification object when a new one is delivered in-app
  - `shutdown` — `{}`, sent once when the server is closing streams for a restart
  - heartbeat comment (`:ping`) every 25 s; clients should auto-reconnect (default EventSource behaviour, server hints `retry: 5000`).
  - capped at `SSE_MAX_CONNECTIONS_PER_USER` concurrent streams per user (429 beyond that).

## Calendar

- `GET /api/calendar/status` → `{ googleConfigured, connected, lastSyncedAt, importExportEnabled }`
- `GET /api/calendar/export.ics` → `text/calendar` of all non-cancelled events. Like every
  other route here it needs the `Authorization` header, so it cannot be a plain
  `<a href download>` — fetch it and save the blob.
- `POST /api/calendar/import` — multipart `file` (.ics ≤2MB) or form field `ics` → `{ imported, skipped }` (UID-deduped)
- Google sync (requires server config):
  - `POST /api/calendar/google/start` → `{ url, expiresIn }` — creates the single-use
    state row and returns the Google consent URL for the client to navigate to.
    **Breaking change:** this used to be a `GET` that answered `302`. That could
    never work. The route is authenticated by header, and the only thing that can
    follow a redirect to Google is a top-level browser navigation, which sends no
    header — so connecting a calendar always failed with `401` before Google was
    ever contacted. The `GET` now answers `405` with `Allow: POST`. Returning the
    URL keeps the credential in a header rather than moving it into a query
    parameter, which is what a public `?ticket=` variant would have required.
  - `GET /api/calendar/google/callback` (public; state-gated) → 302 back to web app.
    Public by necessity — Google redirects the browser here. The `state` row is
    validated, bound to the user who created it and consumed **before** the code is
    exchanged, so the endpoint is not an oracle for outbound token exchanges and a
    failed exchange does not leave the state replayable.
  - `POST /api/calendar/google/sync` → `{ imported, updated, scanned }`
  - `DELETE /api/calendar/google` → disconnect + remove synced mappings

## Inbox webhook

- `POST /api/inbox/webhook` — SendGrid Inbound Parse-compatible form fields (`to`,
  `from`, `subject`, `text`). Disabled (404) unless `INBOX_WEBHOOK_TOKEN` is set.
- The shared secret travels in a **request header**, compared in constant time:
  `X-Inbox-Token: <secret>` (or `X-Webhook-Token`, or `Authorization: Bearer <secret>`).
  For providers that can sign, send `X-Inbox-Signature: sha256=<hex>` where hex =
  `HMAC-SHA256(secret, to+"\\0"+subject+"\\0"+body)` (same `\0` separator as the receipt
  key); the server verifies the HMAC with `constantTimeEqual` and rejects tampered
  bodies with `403 Invalid webhook signature`. When a signature is present it is
  authoritative and the `X-Inbox-Token` header is not required — this is the
  “provider HMAC over (logical) body” step from the audit; a true raw-multipart
  HMAC would require capturing the raw buffer before `multer` and is the next
  iteration. A mismatch is `403`, and the endpoint is rate-limited to 120 requests/minute per
  source address so the secret cannot be ground down at line rate.
  **Breaking change:** `POST /api/inbox/webhook/:token` and `?token=` are gone. A
  secret in a URL is recorded by default in proxy and web-server access logs, browser
  history and `Referer` headers, and rotating it then means auditing every one of
  those. Reconfigure the mail provider to send the header instead.
- Behaviour: resolve the recipient from the **`to`** address only
  (`deadline+<forwardingToken>@domain`, read out of the raw header, so
  `"Priya" <deadline+…@domain>` and multi-recipient headers both resolve) → run
  heuristic extraction on subject+body *in that user's timezone* → auto-save
  candidates with confidence ≥ 0.7 as source `email`
  (max 5) → in-app notification always + email receipt → `202 { ok, savedCount }`.
  An address that resolves to nobody is `202 { ok: true, ignored: "unresolved-recipient" }`.
  `from` is never used to identify the account: it is trivially spoofable, so trusting
  it let anyone who could reach the endpoint write deadlines into another user's
  account. The receipt email carries a content-derived `Message-ID`, so a provider
  that retries the webhook does not produce a second receipt.

## Conventions

- Datetimes in **responses** are ISO-8601 UTC. Datetimes in **requests** must carry an
  explicit offset (`Z` or `±HH:MM`); a naive local time is rejected rather than guessed at.
- The `timezone` field describes the *user-facing* wall clock and must be an IANA zone
  name (`Asia/Kolkata`), never a fixed offset.
- IDs are UUIDv4 strings.
- Every response carries `X-Request-Id`; error bodies repeat it as `requestId`. Quote it
  when reporting a problem — it is the key the server logs are indexed by.

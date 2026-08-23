# Architecture

## System overview

```
┌─────────────┐      HTTPS/JSON       ┌──────────────────┐
│  Next.js UI │ ────────────────────▶ │  Express API     │
│  (web/)     │ ◀──────────────────── │  (server/)       │
└─────────────┘   Bearer JWT (HS256)  └────────┬─────────┘
                                               │
                     ┌─────────────────────────┼──────────────────────────┐
                     ▼                         ▼                          ▼
              node:sqlite (WAL)         Gemini REST (opt.)        SMTP / console mail
              users, events,            text + screenshot          email reminders,
              reminders, deliveries,    deadline extraction        inbox confirmations
              outbox, notifications,
              calendar connections,
              external_events, oauth_states
                     ▲
   SendGrid Inbound Parse / any MTA webhook ──▶ POST /api/inbox/webhook/:token
```

## Request flow & security

1. **Auth**: `POST /api/auth/register|login` returns a signed HS256 JWT (`sub`, `email`, `iss=duekeeper`, `aud=duekeeper-web`). `requireAuth` middleware verifies signature/expiry in constant time, then loads the user row fresh so revoked accounts fail closed. Controllers never accept user IDs from payloads.
   - **Login throttling**: failed sign-ins are limited to 10 per 15 minutes per email+IP pair (sliding window) → `429` with retry hint.
2. **Validation**: zod schemas per route; failures become `422 VALIDATION_ERROR` with field-level details.
3. **Errors**: every failure is `{ error: { code, message, details? }, requestId }` with an 8-hex request id echoed via the `X-Request-Id` header. Unknown errors log server-side and return a generic 500 — no internals leak.
4. **Security headers** on every response: nosniff, DENY framing, strict referrer policy, permissions lockdown. CORS is an explicit origin allowlist (`CORS_ALLOWED_ORIGINS`).
5. **Production guardrails**: startup fails if `JWT_SECRET < 32 chars`, `ENCRYPTION_KEY` missing, `APP_BASE_URL` is not HTTPS, or CORS contains localhost.

## Realtime delivery (SSE)

The engine publishes through an in-process hub (`engine/hub.ts`). When the in-app channel inserts a notification it also calls `publishNotification`, which fans out to every subscribed stream for that user:

- `GET /api/notifications/stream?token=<jwt>` upgrades to `text/event-stream` (token via query param because EventSource cannot set headers).
- On connect the client immediately receives the current unread count; afterwards each new in-app notification and unread-count change is pushed as a named event.
- Heartbeat comments every 25s keep intermediaries from closing idle connections; disconnect cleanup removes listeners. A slow polling fallback in the UI covers reconnect gaps.
- Account deletion closes nothing explicitly — streams fail closed on their next DB touch because the user row is gone.

## The reminder engine (at-least-once delivery)

The engine is split into three stages so that a crash at any point cannot lose or duplicate a reminder beyond the documented at-least-once guarantee:

```
reminders (intent)                reminder_deliveries (business state)      notification_outbox (queue)
┌──────────────────────┐  plan    ┌───────────────────────────┐  enqueue   ┌────────────────────────┐
│ event_id, offset_s,  │ ───────▶ │ id, scheduled_for, status │ ────────▶  │ payload, status,       │
│ channel, enabled     │          │ pending/sent/failed/cxl   │            │ attempts, lease_until… │
└──────────────────────┘          └───────────────────────────┘            └────────────────────────┘
```

1. **Planner (every 60s + on event create/update)**
   - Recomputes live statuses (`upcoming` → `due_soon` within 72h → `overdue`) for non-terminal events in one SQL statement.
   - **Due-soon alerts**: after recomputation, any event that sits in the 72-hour window without a prior alert raises a one-time in-app notification (`idempotency_key = "due_soon:<event_id>"`), skipped when the user disabled `dueSoonAlerts`.
   - For every enabled reminder of an active event whose fire time falls inside `[now, now+7d]`, inserts a `reminder_deliveries` row (`INSERT OR IGNORE`, unique on `reminder_id` ⇒ idempotent) and its `notification_outbox` row keyed by `idempotency_key = "reminder:" + delivery_id`.
   - Cancels pending work for events that became done/cancelled.

2. **Outbox worker (every 30s)**
   - Claims jobs atomically inside `BEGIN IMMEDIATE`: selects `pending AND scheduled_at <= now LIMIT N`, flips them to `processing` with `lease_until = now + OUTBOX_LEASE_SECONDS`, bumping `attempts`.
   - Delivers by channel:
     - `in_app`: `INSERT OR IGNORE INTO notifications … idempotency_key = "reminder:"+deliveryId` ⇒ worker retries can never create duplicate rows.
     - `email`: SMTP send (or structured console line in dev). Missing recipient is a permanent error.
   - Success ⇒ `sent` (+ delivery marked sent). Transient failure ⇒ back to `pending` with `next_retry_at = now + min(10min, 30s·2^(attempts-1))`. Permanent error or `attempts ≥ max(3)` ⇒ `failed`.
   - **Watchdog (60s)** reclaims rows stuck in `processing` whose lease expired — a crashed worker's jobs are retried safely because all state transitions are guarded by `status='processing'`.

3. **Cancellation**: marking done/cancelled, snoozing, deleting, or editing due dates first cancels all `pending` deliveries/outbox rows for that event, then re-plans against the new state.

### Why SQLite is enough here
Single-process deployment; `BEGIN IMMEDIATE` gives the same writer serialization that `FOR UPDATE SKIP LOCKED` provides on Postgres. The lease/watchdog pattern means multiple workers would still be safe if scaled out behind one database file volume.

## Deadline extraction

- `POST /api/events/extract` accepts either multipart `screenshot` (PNG/JPEG/WebP magic-byte validated, ≤10MB) or JSON `{text}`. Rate-limited to **10 requests/hour/user** (sliding window, in-memory).
- With `GEMINI_API_KEY`: prompt injects today's date + user timezone, demands strict JSON array output (`responseMimeType: application/json`), maps `due_date`+`due_time`+IANA zone → UTC instant, clamps confidence, flags `needs_clarification`.
- Without a key (or when Gemini 5xx's): the built-in heuristic parser takes over — segments input, resolves ISO / "Sep 15" / DD/MM / "tomorrow"/"next friday"/"in 3 days", am/pm times, defaults to 23:59, infers type from keywords and confidence from signal quality. Naive wall-clock times are converted to UTC through the user's timezone using Intl offsets.
- Nothing is auto-saved from the client flow: candidates come back for review/edit in `ExtractionPreview`, then `/confirm` persists them as `user_confirmed`. Only the **email inbox** auto-saves (confidence ≥ 0.7) since there's no human in the loop at forward time.

## Calendar interop

- `.ics` import unfolds RFC5545 lines, parses `DTSTART` (UTC `Z`, local-with-`TZID`, date-only), dedupes by `(user, 'ics', UID)` via `external_events`.
- Export generates folded, escaped VCALENDAR for all non-cancelled events.
- Google sync (optional): single-use 10-minute OAuth `state` row consumed atomically in the callback; refresh/access tokens stored AES-256-GCM encrypted (`secretbox`); incremental `syncToken`; HTTP 410 triggers automatic full resync; only keyword-matching events (exam/due/submit/hackathon…) are imported, identity-mapped by `(user, 'google', eventId)`.

## Inbox forwarding

`POST /api/inbox/webhook/:token` — enabled only when `INBOX_WEBHOOK_TOKEN` is set (otherwise 404). Token compared via SHA-256 + `timingSafeEqual`. Recipient resolution prefers the `deadline+<forwarding_token>@domain` local-part; sender email is only used after the token gate passes. Auto-saves high-confidence deadlines, always notifies in-app, emails a receipt.

## Data integrity rules

- Published migrations are immutable; corrections go forward.
- All timestamps are ISO-8601 UTC strings — lexicographic order equals chronological order.
- Ownership enforced in SQL (`WHERE user_id = ?`) everywhere; FKs cascade from users → everything.

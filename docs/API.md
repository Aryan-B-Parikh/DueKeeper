# API Reference

Base URL (dev): `http://localhost:8080`
All bodies are JSON unless noted. Authentication: `Authorization: Bearer <jwt>` on every route except `/api/health/*` and `/api/inbox/webhook*`.

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
| 401 | UNAUTHORIZED | Missing/invalid/expired token |
| 403 | FORBIDDEN | Webhook token mismatch |
| 404 | NOT_FOUND | Unknown resource or disabled feature |
| 409 | CONFLICT | Duplicate email |
| 413 | PAYLOAD_TOO_LARGE | Upload > size cap |
| 415 | UNSUPPORTED_MEDIA_TYPE | Bad image format |
| 422 | VALIDATION_ERROR | Schema validation failed |
| 429 | RATE_LIMITED | >10 extractions/hour |
| 502 | EXTERNAL_SERVICE_ERROR | Gemini unreachable/invalid |

## Health

- `GET /api/health` → `{ ok, name, version, uptimeSeconds }`
- `GET /api/health/liveness` → `{ ok: true }` (always)
- `GET /api/health/readiness` → `{ ok, database: "up" }` or 503 `{ ok:false, database:"down" }`

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

- `GET /api/user/push/status` → `{ available, subscribedDevices }`
- `GET /api/user/push/public-key` → `{ available, publicKey }` — base64url P-256 application server key
- `POST /api/user/push/subscribe` `{ endpoint, keys: { p256dh, auth } }` → `201`, upserted per endpoint
- `POST /api/user/push/unsubscribe` `{ endpoint }` → `{ ok }`
- `POST /api/user/push/test` → `{ sent, removed }` — sends an encrypted test notification to every registered device; endpoints answering 404/410 are pruned automatically

## Events

- `GET /api/events[?status=active|upcoming|due_soon|overdue|done|cancelled|all]` → `{ events: Event[] }` ordered by `dueAt`.
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
- `PUT /api/events/:id` — same body; replaces reminders and re-plans deliveries.
- `DELETE /api/events/:id` → `204`
- `POST /api/events/:id/done` → `{ event }` (status `done`, pending reminders cancelled)
- `POST /api/events/:id/cancel` → `{ event }` (status `cancelled`, pending reminders cancelled)
- `POST /api/events/:id/snooze` `{ "duration": "30m" | "2h" | "1d" }` — positive values only; shifts due date (from now if already overdue), re-plans reminders.

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

- `GET /api/notifications[?unreadOnly=true][&limit=50]` → `{ notifications, unreadCount }`
- `GET /api/notifications/unread-count` → `{ unreadCount }`
- `POST /api/notifications/:id/read` → `{ ok }`
- `POST /api/notifications/read-all` → `{ ok }`

Notification: `{ id, eventId|null, type: reminder|system|info|warning, title, body, read, createdAt }`

### Live stream (SSE)

- `GET /api/notifications/stream?token=<jwt>` → `text/event-stream`.
  Auth via query parameter (EventSource cannot set headers). Events:
  - `unread` — `{ count }`, sent on connect and whenever unread state changes
  - `notification` — full notification object when a new one is delivered in-app
  - heartbeat comment (`:ping`) every 25 s; clients should auto-reconnect (default EventSource behaviour, server hints `retry: 5000`).

## Calendar

- `GET /api/calendar/status` → `{ googleConfigured, connected, lastSyncedAt, importExportEnabled }`
- `GET /api/calendar/export.ics` → `text/calendar` of all non-cancelled events
- `POST /api/calendar/import` — multipart `file` (.ics ≤2MB) or form field `ics` → `{ imported, skipped }` (UID-deduped)
- Google sync (requires server config):
  - `GET /api/calendar/google/start` → 302 to Google consent (creates single-use state)
  - `GET /api/calendar/google/callback` (public; state-gated) → 302 back to web app
  - `POST /api/calendar/google/sync` → `{ imported, updated, scanned }`
  - `DELETE /api/calendar/google` → disconnect + remove synced mappings

## Inbox webhook

- `POST /api/inbox/webhook/:token` (or `?token=`) — SendGrid Inbound Parse-compatible form fields (`to`, `from`, `subject`, `text`). Disabled (404) unless `INBOX_WEBHOOK_TOKEN` is set; wrong token → 403 constant-time compare.
- Behaviour: resolve recipient by `deadline+<token>@domain` local part → run heuristic extraction on subject+body → auto-save confidence ≥ 0.7 as source `email` → in-app notification always + email receipt → `202 { ok, savedCount }`.

## Conventions

- All datetimes in requests/responses are ISO-8601 UTC (`dueAt`). The `timezone` field describes the *user-facing* wall clock.
- IDs are UUIDv4 strings.

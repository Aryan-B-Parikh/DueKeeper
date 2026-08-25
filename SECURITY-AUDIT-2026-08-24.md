# Security Audit — DueKeeper — 2026-08-24 (Historical)

> **Historical audit. All findings were subsequently remediated in commit c4785e860cd92bf1886438da9dfbf9dbfacbe05c (and follow-up 429e2a0 for PG/Redis). See `SECURITY.md` for current reporting.**

**Scope:** `D:\DueKeeper\server` — 53 TypeScript source files, ~7k lines. Reviewed 2026-08-24 against the working tree.
**Stack:** Express 4, TypeScript strict, `node:sqlite` (`DatabaseSync`), Zod, multer, nodemailer. Node >=24. Five runtime dependencies.

**Overall: 6.8 / 10 — a well-architected codebase with a small number of serious defects.**

> **Status: remediated.** Every finding below — C1–C4, H1–H8, the medium-severity
> items in §5 and all seventeen steps of the §8 plan — is closed in the working
> tree. The findings are left exactly as they were written, because they are the
> record of what was wrong; **§9 says for each one which file and which mechanism
> closes it**, and which risks were accepted rather than fixed. Scores in §7
> describe the tree as reviewed on 2026-08-24 and have not been restated.

This is materially better engineering than most projects of its size. The layering is clean, every SQL statement is parameterized, the security posture is deliberate rather than accidental, and the production config guard actually refuses to boot when misconfigured. It loses points for three things: one cryptographic implementation that is silently and completely broken, a reminder pipeline whose reliability primitives are written but not wired up, and a systematic gap between what the code intends and what it verifies.

The single most important finding: **web push has never worked, and nothing in the system can tell you that.**

---

## 1. Architecture

`src/index.ts` runs migrations, starts the HTTP server, then starts two `setInterval` loops. `src/app.ts` composes middleware and mounts eight routers under `/api`. Modules are vertically sliced (`routes` + `service` per domain), with shared primitives in `lib/`.

Data lives in SQLite via `node:sqlite`'s `DatabaseSync`, opened once with WAL, `foreign_keys = ON`, and a 5s busy timeout (`db/database.ts:13-15`). Migrations are an append-only array in `db/schema.ts` — five so far, applied by id.

The schema is the strongest artifact in the repo. It uses `CHECK` constraints on every enum column, `ON DELETE CASCADE` throughout, `UNIQUE` on `notification_outbox.idempotency_key` and `notifications.idempotency_key`, and purpose-built indexes including a partial index on `(status, lease_until) WHERE status = 'processing'`. Someone thought carefully about this.

The dependency minimalism is deliberate and mostly successful. Hand-rolled JWT, scrypt, AES-GCM secretbox, ICS, and rate limiting are all correct. Hand-rolled web push encryption is not.

---

## 2. Flows

**Auth.** `POST /api/auth/register|login|refresh|logout`, `GET /api/auth/me`. Register and login return an access token (HS256 JWT, 15m) plus a refresh token (384 bits from `randomBytes(48)`, stored SHA-256 hashed). Refresh rotates: the old row gets `revoked_at` + `replaced_by_hash`, a new row is inserted, both in one transaction. Reuse of an already-rotated token triggers `revokeAllForUser` — real theft detection.

Access tokens carry `ver`, compared on every request against `users.token_version` (`middleware/auth.ts:32`), giving instant server-side revocation.

**Events.** Full CRUD under `/api/events`, plus `/:id/done`, `/:id/cancel`, `/:id/snooze`. Every mutation replaces the event's reminders wholesale and re-plans deliveries. Ownership is enforced by a `getEventRow(userId, eventId)` guard before each write.

**Extraction.** `POST /api/events/extract` takes pasted text or a screenshot; `POST /api/events/extract/confirm` persists chosen candidates. With `GEMINI_API_KEY` set, text and images go to Gemini; without it, text falls back to a hand-written heuristic parser (keyword gate, then ISO / month-name / numeric / relative date patterns with confidence scoring). Images are validated by magic bytes, not client MIME (`extract/imageValidate.ts:9-24`) — correct.

**Reminder engine.** The core loop, and the most interesting part of the system:

```
reminders (user-defined offsets)
  → planner tick (60s): materialize reminder_deliveries + notification_outbox
  → outbox tick (30s): BEGIN IMMEDIATE, claim N pending rows, set lease + attempts++
  → deliver: email (SMTP) | in-app (SSE + push fan-out)
  → finishSent + markDelivery
  → lease watchdog (60s): reclaim expired 'processing' rows
```

**Notifications.** SSE stream at `/api/notifications/stream`, with a 25s heartbeat and an in-process subscriber map.

**Calendar.** Google OAuth (read-only scope, `access_type=offline`), incremental sync via `syncToken`, plus ICS import/export.

**Inbox.** A webhook receives forwarded email, maps recipient → user via a per-user `forwarding_token` in the address local part (`deadline+<hex>@…`), runs the heuristic extractor, and auto-saves high-confidence deadlines.

---

## 3. Critical findings

### C1 — Web push encryption is wrong; every notification is undecryptable

`lib/push/webpush.ts:49`

```ts
const prkKey = hkdf(authSecret, sharedSecret, Buffer.from('Content-Encoding: auth\0'), 32);
```

The wrapper is `hkdf(ikm, salt, info, len)` mapping onto `hkdfSync('sha256', ikm, salt, info, len)` (`webpush.ts:31-33`), so this computes HKDF with `ikm = authSecret` and `salt = sharedSecret`.

RFC 8291 §3.3 requires the opposite, plus a step that is missing entirely:

```
ikm = HMAC-SHA256(auth_secret, ecdh_secret ‖ "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public)
PRK = HKDF-Extract(salt, ikm)
```

Three independent defects: the `"WebPush: info"` IKM derivation is absent; `auth_secret` and `ecdh_secret` are swapped; and the CEK/nonce `info` strings (`webpush.ts:51-62`) append a `"P-256" ‖ len ‖ pubkey` context borrowed from the obsolete draft-04 `aesgcm` scheme, whereas `aes128gcm` mandates exactly `"Content-Encoding: aes128gcm\0"` with no suffix.

The header framing and VAPID JWT signing are both correct, which makes this worse — the request is well-formed, so push services return 201 and the server counts a success.

**Why it is invisible:** three layers of silence stack up. `push.service.ts:46` deliberately skips logging `status === 0`; `notifier.ts:31-32` discards push results with `.catch(() => undefined)`; and `metrics.pushesSent` increments on the 201. Worst of all, `decryptPayload` (`webpush.ts:81-120`) reimplements the *same wrong* derivation, so the round-trip test in `tests/push.test.ts:58` passes and certifies the bug as correct.

**Impact:** web push has never delivered a readable notification to any browser, and the test suite and metrics both report health.

**Fix:** replace with the `web-push` library, or implement RFC 8291 §3.3 exactly and test against a real browser subscription rather than the same code path.

### C2 — Exponential backoff is dead code; SMTP outages permanently destroy reminders

`engine/outbox.ts:156-160` writes `next_retry_at` on failure. `engine/outbox.ts:60-62` claims work with:

```sql
SELECT id FROM notification_outbox
WHERE status = 'pending' AND scheduled_at <= ?
ORDER BY scheduled_at ASC LIMIT ?
```

`next_retry_at` is never read — anywhere in the codebase — and `scheduled_at` is never updated. The carefully written `Math.min(600_000, 30_000 * 2 ** (attempts - 1))` never influences anything. The index `idx_outbox_claim(status, scheduled_at, next_retry_at)` proves the predicate was meant to include it.

Because `attempts` increments at claim time and `max_attempts` is 3, all three attempts burn on three consecutive 30-second ticks. **Any SMTP outage longer than ~90 seconds permanently dead-letters every reminder due in that window.** There is no dead-letter queue, no alert, and no re-drive path. The log line claiming `"retry in 120s"` (`outbox.ts:161`) is false.

**Fix:** add `AND (next_retry_at IS NULL OR next_retry_at <= ?)` to the claim predicate.

### C3 — A crash between two inserts loses a reminder forever

`engine/planner.ts:140-152` performs two inserts with no transaction:

```ts
const inserted = prepare(`INSERT OR IGNORE INTO reminder_deliveries …`).run(…);
if (inserted.changes === 0) continue;
prepare(`INSERT OR IGNORE INTO notification_outbox …`).run(…);
```

`reminder_deliveries.reminder_id` is `UNIQUE` (`schema.ts:54`). If the process dies between the two statements, the delivery row exists without an outbox row. On the next tick the insert returns `changes === 0` and `continue` skips outbox creation — **permanently**. The reminder is silently lost, leaving a `pending` row as the only evidence.

`inTransaction` is imported in `outbox.ts:1` and never used; `planner.ts` does not import it at all. The primitive exists and is correct (`db/database.ts:27-42`) — it simply was not applied.

The same `UNIQUE` constraint means a completed-then-reopened event can never re-plan its reminders, and editing `due_at` after a delivery is materialized leaves the stale `scheduled_for` uncorrected.

### C4 — Password change and "revoke all sessions" do not revoke refresh tokens

`modules/users/users.routes.ts:126-131` and `:138` both bump `token_version` and nothing else. `revokeAllForUser` exists at `lib/tokens.ts:111-115` and is not called from either.

Bumping `token_version` invalidates access tokens only. `rotateRefreshToken` never checks `token_version` — it reads the current value and mints a fresh access token with it (`tokens.ts:98`). An attacker holding a stolen refresh token regains full access immediately after the victim changes their password.

The endpoint responds `{ ok: true, sessionsRevoked: true }`. That claim is false, which makes this worse than a silent bug: the user is told they are safe.

**Fix:** call `revokeAllForUser(userId)` in both handlers.

---

## 4. High-severity findings

### H1 — Google Calendar OAuth cannot complete

`modules/calendar/calendar.routes.ts:22` applies `calendarRouter.use(requireAuth())` to the entire router, including `/google/callback` and `/sync/callback` (`:182-183`). `requireAuth` reads credentials only from the `Authorization` header (`middleware/auth.ts:17-18`); there is no cookie fallback.

Google's callback is a top-level browser navigation and cannot carry a Bearer header, so it is rejected before the handler runs. `/google/start` has the mirror problem: it 302s to Google but is reachable only via authenticated XHR. **The entire Google Calendar feature is non-functional.**

This currently masks H2 and H3 — both become live the moment the callback is made reachable.

### H2 — OAuth token exchange happens before state validation

`calendar.routes.ts:147-155` calls `exchangeCodeForTokens(code)` first, and only then opens a transaction to validate `state`. Two consequences: the endpoint becomes an unauthenticated oracle that drives outbound token-exchange requests carrying the app's `client_secret`; and when the exchange throws, the transaction never runs, so the state row is never marked `used` and stays replayable for its full 10-minute window.

Additionally, `req.user!.id` is never compared against `stateRow.user_id` (`:169`), so a leaked `state` lets an attacker bind their Google account to a victim's DueKeeper account.

**Fix:** validate and consume state first, exchange second, and assert `req.user.id === stateRow.user_id`.

### H3 — Inbound email trusts the attacker-controlled `from` field

`modules/inbox/inbox.routes.ts:61-64`:

```ts
let userId = resolveUserIdByTokenAddress(to);
if (!userId && from) {
  userId = getUserRowByEmail(from)?.id ?? null;
}
```

The primary path is sound — an anchored hex `forwarding_token` in the recipient address. The fallback undoes it: `from` is an unauthenticated request field and a trivially spoofable SMTP header. Anyone holding the single shared `INBOX_WEBHOOK_TOKEN` can write auto-saved events into any account by setting `from`.

Compounding it, `:66` logs the full recipient — which contains the per-user `forwarding_token` — and `lib/logger.ts:24` applies no redaction. The webhook token itself travels in the URL path or query (`:125-126, 134`), where access logs and proxies capture it by default.

**Fix:** delete the `from` fallback. Move the shared secret to a header, ideally a provider HMAC over the raw body.

### H4 — Rate limiting is trivially bypassed

`modules/auth/auth.routes.ts:35-38`:

```ts
const forwarded = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();
return forwarded || req.ip || 'local';
```

The client-supplied header takes priority over `req.ip` with no trust check. A fresh random `X-Forwarded-For` per request yields a fresh bucket, defeating both limiters entirely. Since keys are attacker-controlled and `sweep` only runs once per 60s with no entry cap (`lib/rateLimit.ts:13-20`), this doubles as unbounded memory growth.

The login key is `${email}|${ip}` (`:57`), so there is no IP-only cap — one host can try unlimited distinct emails. `/refresh`, `/logout`, and `/password` have no limiter at all; `/password` runs two full scrypt derivations per request (`users.routes.ts:118, 121`), roughly 32 MiB, making it a CPU/memory amplifier.

Note `app.set('trust proxy', 1)` is set in `app.ts:24`, so `req.ip` is already correct — the manual header parsing is not just unsafe, it is unnecessary.

### H5 — Naive datetime strings are parsed in the server's timezone

`modules/events/events.routes.ts:34-37` validates `dueAt` only as non-NaN, and `events.service.ts:268` stores `new Date(input.dueAt).toISOString()`. A value without an offset is interpreted in the **server's** zone per ECMAScript, while the client's actual zone sits unused in the `timezone` column, never read by any date computation.

For a deadline product, a reminder firing hours off is a core-function failure.

### H6 — Snooze accepts unbounded durations and throws a 500

`events.routes.ts:45` accepts any digit count; `events.service.ts:354` then calls `.toISOString()` on the result. `{"duration":"999999999d"}` exceeds the ±8.64e15 ms `Date` range and throws `RangeError`.

### H7 — `markFailed` has no status guard

`engine/outbox.ts:165-168` updates `WHERE id = ?` with no `AND status = 'processing'`, unlike its siblings `finishSent` (`:150`) and `scheduleRetry` (`:159`). After a lease expires and the watchdog re-queues a job the original worker is still processing, the stale worker's `markFailed` overwrites whatever the new worker wrote — including `'sent'`. `markDelivery` (`:173`) is likewise unguarded.

### H8 — Delete leaves pending notifications live

`events.service.ts:310-313` deletes the event without calling `cancelPendingWork`, unlike update, done, cancel, and snooze. Whether the orphaned rows cascade depends on FK behavior; the outbox row references `reminder_deliveries`, not `events`, so at minimum the intent is inconsistent.

---

## 5. Medium-severity findings

**Reliability.** The lease watchdog waits twice the configured lease — `cutoff` is `now - leaseSeconds` compared against a `lease_until` already `claimTime + leaseSeconds` (`outbox.ts:40-45`), so recovery takes 240s not 120s. Reclaim does not decrement `attempts`, so three crashes permanently kill a reminder. Jobs whose fire time passed during downtime are never planned at all (`planner.ts:136`, no grace window) — the sibling code path in `events.service.ts:199` allows 60s, so the two producers disagree. Shutdown does not drain in-flight work; `closeDb()` runs while a job may be awaiting SMTP. There is no `unhandledRejection` or `uncaughtException` handler.

**Concurrency.** Refresh rotation reads and validates outside the transaction it later opens (`tokens.ts:55-76`), so two concurrent refreshes can both succeed and defeat theft detection. Both engine loops guard overlap with a boolean that *drops* ticks rather than deferring them, so a slow tick silently degrades cadence.

**Cross-user writes.** Push registration upserts reassign `user_id` on conflict with no ownership check (`users.routes.ts:170-173, 200-207`). Anyone learning a victim's endpoint can detach their device and redirect it. The delete paths are correctly scoped, which shows the omission was an oversight.

**Blocking I/O.** `node:sqlite` is synchronous, so every query blocks the event loop. The planner's main query has no `LIMIT` (`planner.ts:122-131`) and runs 2 inserts per row every 60s; `claimJobs` holds SQLite's write lock across `BEGIN IMMEDIATE`…`COMMIT`. The outbox processes up to 50 jobs strictly serially (`outbox.ts:185-187`), each awaiting a network round-trip against a 120s lease — average SMTP latency above ~2.4s means the batch tail exceeds its lease and gets redelivered. No `AbortSignal` on the push or Expo `fetch` calls, and no `socketTimeout` on the nodemailer transport, so one hung remote stalls the loop indefinitely.

**Email has no idempotency key of any kind**, so the duplicate paths above produce duplicate mail.

**SSE.** `/stream` bypasses `requireAuth()` and accepts a full JWT as a query parameter (`notifications.routes.ts:91-96`) — the component most likely to land in proxy logs, browser history, and `Referer`. `res.write`'s return value is ignored, so a slow client buffers unboundedly, and there is no per-user subscription cap.

**Silent production degradation.** `resolveEmailService` falls back to console logging whenever `SMTP_HOST` is unset — **including in production** (`emailChannel.ts:51-58`) — and the outbox then marks the job `sent`. Startup only warns.

**Encryption key derivation.** `secretbox.ts:19` falls back to `sha256("duekeeper-dev-" + JWT_SECRET)`, and to a fully public constant when `JWT_SECRET` is also unset. Guarded by `NODE_ENV === 'production'` only, so staging or an unset `NODE_ENV` lands here. Even when it works, deriving the encryption key from the token-signing secret violates key separation. There is also no key rotation: the `v1.` prefix implies versioning that `getKey()` does not implement, and rotation silently breaks sync forever because `google.ts:104-108` swallows the decrypt failure and reports an empty successful sync.

**Correctness.** Timezone conversion samples the offset at the naive-as-UTC instant and never re-checks (`dateUtils.ts:51-54`), producing hour-off results near DST transitions — and the flawed algorithm is duplicated inline in `extract.routes.ts:60-75`. Heuristic date parsing accepts `2026-02-31` and `2026-99-99` with no calendar validation. Relative dates ("tomorrow", "next friday") resolve in the server's zone. ICS export escaping misses a bare `\r` (`ics.ts:123`), permitting property injection in lenient parsers, and `toIcsDateTime` (`:139-141`) emits invalid output for any non-`Z` timestamp. Editing any field of a done event silently reopens it (`events.service.ts:288`). List endpoints have no pagination — a hardcoded `LIMIT 500` with in-memory status filtering applied *after* the cap, so `?status=overdue` silently returns incomplete results past 500 events.

**Prompt injection.** User text and the `timezone` field are interpolated raw into the Gemini instruction block (`gemini.ts:25, 29`), with `timezone` validated only as "contains a slash" and never length-capped. Model output types are never checked (`gemini.ts:90` asserts only non-null object), so `"timezone": 5` throws a `TypeError` outside the try block at `extract.routes.ts:56`. Impact is currently self-directed, but it escalates the moment extraction output is shown to anyone else.

---

## 6. What the code does well

Worth stating plainly, because these are choices many teams get wrong:

**JWT verification is genuinely correct.** `verifyJwt` never parses the header's `alg` — it unconditionally applies HMAC-SHA256 and compares with `timingSafeEqual` behind a length guard (`lib/jwt.ts:69-70`). Alg-confusion and `alg: none` are structurally impossible, not merely blocked. `exp`, `iss`, and `aud` are all enforced.

**Password handling is sound.** scrypt with a 16-byte per-hash CSPRNG salt, self-describing parameters enabling future upgrades, NFKC normalization on both sides, and `timingSafeEqual` comparison with the length mismatch made unreachable by construction (`lib/password.ts:24-25`). N=16384 is below current OWASP guidance (2^17) but is Node's default and a reasonable choice.

**AES-256-GCM secretbox is textbook.** Fresh 96-bit random nonce per encryption, tag appended and verified via `final()`, length floor checked. No IV reuse, no ECB, no unauthenticated mode.

**Refresh token rotation with theft detection** — reuse of a rotated token revokes the entire family. Many production systems lack this.

**Zero SQL injection.** Every statement across all 53 files uses prepared statements with bound parameters. The single interpolated fragment builds `?` placeholders only.

**No IDOR in the events module.** Every request-supplied id passes an ownership check first.

**Security headers by default** — `nosniff`, `X-Frame-Options: DENY`, a locked-down CSP, `Referrer-Policy`, and `Permissions-Policy`, plus per-request correlation ids (`middleware/requestContext.ts:4-15`). HSTS is the notable omission.

**The error handler does not leak.** Unknown errors get a fixed generic message; stacks go only to logs (`errorHandler.ts:33-36`).

**The production config guard actually refuses to boot** on a weak `JWT_SECRET`, missing `ENCRYPTION_KEY`, non-HTTPS base URL, or localhost CORS (`config/env.ts:125-152`). The `ALLOW_LOCALHOST_E2E` escape hatch is explicit and loudly logged.

**Least-privilege OAuth scope** — `calendar.readonly`, not full access.

**Magic-byte image validation** rather than trusting client `Content-Type`.

---

## 7. Ratings

| Area | Score | Notes |
|---|---|---|
| Architecture & structure | 8.5 | Clean vertical slices, sensible layering, well-designed schema |
| Data model & migrations | 8.5 | CHECK constraints, cascades, purposeful indexes; append-only migrations |
| SQL safety | 10 | Parameterized without exception |
| Authentication & tokens | 7.5 | Correct primitives; undermined by C4 |
| Authorization / tenancy | 7.0 | Events solid; push upserts and OAuth binding leak across users |
| Cryptography | 5.0 | JWT/scrypt/GCM excellent; web push (C1) is broken and self-certifying |
| Input validation | 7.5 | Zod throughout; gaps in timezone, snooze, model output |
| Reliability & job engine | 4.5 | Right design, unwired primitives — C2, C3, H7 |
| Concurrency & transactions | 5.0 | `inTransaction` exists and is unused where it matters most |
| Error handling & observability | 6.0 | No leakage; pervasive silent swallowing, no redaction, no alerting |
| Correctness (dates/timezones) | 5.0 | H5 and DST handling are core-function failures for a deadline app |
| Testing | 4.0 | 66 assertions, unit-only, no HTTP/integration tests; one test certifies a bug |
| Config & secrets | 7.5 | Strong prod guard; weak dev key derivation, no rotation |
| Dependency posture | 8.0 | Five deps, current versions, minimal supply-chain surface |

**Weighted overall: 6.8 / 10**

---

## 8. Recommended order of work

**Before any production traffic**

1. Fix web push encryption (C1) — adopt `web-push`, or implement RFC 8291 §3.3 and validate against a real browser, not `decryptPayload`.
2. Add `next_retry_at` to the outbox claim predicate (C2) — one line, prevents permanent reminder loss.
3. Wrap the planner's paired inserts in `inTransaction` (C3), and the outbox's sent-bookkeeping too.
4. Call `revokeAllForUser` on password change and revoke-all (C4).
5. Move the OAuth callback outside `requireAuth`, validate state before exchanging, and bind it to the session (H1, H2).
6. Delete the `from` fallback in the inbox webhook; move its token to a header; stop logging the recipient (H3).

**Before opening to untrusted users**

7. Use `req.ip` instead of raw `X-Forwarded-For`; add an IP-only login cap; rate-limit `/refresh`, `/logout`, `/password` (H4).
8. Require an IANA timezone and an offset-bearing `dueAt`; do the conversion with a two-pass DST-aware helper (H5).
9. Bound snooze duration (H6). Add `AND status = 'processing'` to `markFailed`/`markDelivery` (H7).
10. Add an ownership check to both push upserts.
11. Move the SSE token out of the query string.
12. Fail startup in production when `SMTP_HOST` is unset, rather than silently logging mail to console.

**Structural**

13. Add HTTP-level integration tests — the current suite would not have caught a single finding in this report.
14. Add pagination to list endpoints and filter status in SQL, not memory.
15. Add timeouts to every outbound `fetch` and to the SMTP transport.
16. Log push failures; add a dead-letter view and an alert on `remindersFailed`.
17. Separate `ENCRYPTION_KEY` from `JWT_SECRET`; implement real key rotation behind the existing `v1.` prefix.

---

## 9. Remediation status

Re-verified 2026-08-25 against the working tree. Nothing in this section is a plan:
every row names the file and the mechanism that closes the finding, and each one is
covered by a test that fails if the fix is reverted.

### Critical

| # | Closed by | Mechanism |
|---|---|---|
| C1 | `lib/push/webpush.ts`, `tests/push.test.ts` | RFC 8291 §3.3 implemented literally: `ikm = HMAC-SHA256(auth_secret, ecdh_secret ‖ "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public)`, then `HKDF-Extract(salt, ikm)`, with the `aes128gcm` CEK and nonce `info` strings and none of the draft-04 `"P-256" ‖ len ‖ pubkey` suffix. The self-certifying round trip is replaced by the **published test vector from RFC 8291 §5** — externally fixed inputs and expected ciphertext, so the test can no longer agree with our own arithmetic. Failures are logged and counted in `metrics.pushesFailed` instead of being swallowed by `.catch(() => undefined)`. |
| C2 | `engine/outbox.ts:105` | The claim predicate now reads `AND (next_retry_at IS NULL OR next_retry_at <= ?)`, which is what `idx_outbox_claim` was built for. Backoff is live, so an SMTP outage defers rather than destroying. Reclaims are counted in their own column instead of consuming `attempts`, and `outboxQueueDepth()` publishes `claimable` and `oldestClaimableAgeSeconds` so a backlog is visible while there is still time to act. |
| C3 | `engine/planner.ts`, `engine/scheduling.ts`, migration `006_delivery_rescheduling_and_reclaims` | The paired inserts run inside `inTransaction`, so a crash between them rolls back instead of leaving a delivery row with no outbox row. The `UNIQUE` on `reminder_deliveries.reminder_id` — the reason a reopened or rescheduled event could never re-plan — is rebuilt as `UNIQUE (reminder_id, scheduled_for)`, so moving `due_at` materializes a new delivery rather than colliding with the stale one. |
| C4 | `lib/tokens.ts:153`, `modules/users/users.routes.ts:129,138` | `revokeAllSessions` bumps `token_version` **and** revokes every stored refresh row, in one transaction, and both the password-change and revoke-all handlers call it. `{ sessionsRevoked: true }` is now a true statement. |

### High

| # | Closed by | Mechanism |
|---|---|---|
| H1 | `modules/calendar/calendar.routes.ts`, `web/src/lib/api.ts` | The callback is mounted outside `requireAuth` and gated on `state` instead. The start leg became `POST … → { url, expiresIn }`: an authenticated redirecting `GET` was unreachable by construction, because the only thing that can follow a redirect to Google is a browser navigation and a navigation carries no `Authorization` header. The old `GET` answers `405` with `Allow: POST` rather than a bare 404. |
| H2 | `calendar.routes.ts` | `state` is validated, compared against `stateRow.user_id`, and consumed **before** `exchangeCodeForTokens` runs. The endpoint is no longer an oracle for outbound exchanges carrying `client_secret`, and a failed exchange leaves nothing replayable. |
| H3 | `modules/inbox/inbox.routes.ts`, `lib/logger.ts` | The `from` fallback is deleted; recipients resolve from the raw `to` header only, which now tolerates display names and multi-recipient headers. The shared secret is header-only (`X-Inbox-Token`, constant-time compare), rate-limited to 120/min per source. The recipient address is redacted at the call site, and the logger redacts forwarding addresses, bearer tokens, JWTs and `?ticket=` values everywhere else. |
| H4 | `modules/auth/auth.routes.ts:39-42`, `lib/rateLimit.ts` | `req.ip` under the already-configured `trust proxy`, with the manual `X-Forwarded-For` parsing gone. An IP-only login cap sits beside the per-email one, `/refresh`, `/logout` and `/password` all have limiters, and every limiter is bounded by `maxKeys` so attacker-chosen keys cannot grow memory without limit. |
| H5 | `lib/datetimeValidation.ts`, `lib/zonedTime.ts` | `dueAt` must carry an explicit offset or it is `422`; `timezone` must be an IANA name, and a fixed offset is refused because it cannot answer a DST question. Conversion is a two-pass offset-resampling helper, and the inline duplicate of the flawed algorithm in `extract.routes.ts` is gone — events, ICS and the heuristic parser all call the same code. |
| H6 | `events.routes.ts:66`, `events.service.ts` | Snooze is bounded to 1m…30d with an explicit `Date`-range check, so `999999999d`, `0m` and `-30m` are all `422` rather than a `RangeError` surfacing as a 500. |
| H7 | `engine/outbox.ts:144,223,253` | `markFailed` and `markDelivery` carry `AND status = 'processing'`, matching `finishSent` and `scheduleRetry`. A stale worker whose lease expired can no longer overwrite `'sent'`. |
| H8 | `events.service.ts:417-428` | `deleteEvent` checks ownership, cancels pending work, then deletes — one transaction, same shape as update, done, cancel and snooze. |

### Medium (§5)

**Reliability.** The watchdog cutoff is computed against `lease_until` directly, so
recovery takes one lease rather than two. Reclaims live in their own column instead
of consuming `attempts`, and a job reclaimed past its bound is dead-lettered rather
than cycling forever. `PLANNER_GRACE_SECONDS` (default 60) gives the planner the same
grace window `events.service.ts` already allowed, so a fire time that passed during
downtime is still planned and the two producers agree. Shutdown stops the intervals,
drains in-flight outbox work against a deadline, ends every SSE stream with a
`shutdown` event, and only then closes the database. `unhandledRejection` and
`uncaughtException` are handled, logged and counted in `metrics.unhandledErrors`.

**Concurrency.** Refresh rotation reads, validates and writes inside a single
`inTransaction`, so two concurrent refreshes cannot both succeed and defeat theft
detection. A tick arriving mid-cycle is folded into a catch-up run and counted in
`metrics.engineTicksCoalesced` instead of being dropped, so a slow cycle degrades
visibly rather than silently.

**Cross-user writes.** Both push upserts check ownership and the per-account device
cap inside one transaction, and the ownership rule is repeated in the
`ON CONFLICT … WHERE` clause so it is part of the statement and not only part of the
preceding check.

**Blocking I/O.** The outbox drains with bounded concurrency
(`OUTBOX_CONCURRENCY`, default 5) over a shared queue rather than fifty serial
awaits, so the batch tail no longer outlives its lease. The planner's query has a
`LIMIT`. Every outbound `fetch` — web push, Expo, Google, Gemini — runs under an
`AbortController` timeout, and nodemailer has connection, greeting and socket
timeouts, so one hung remote cannot stall the loop.

**Email idempotency.** Reminder mail derives a key per delivery and sends it as both
`Message-ID` and `X-Entity-Ref-ID`. The inbox receipt derives its key from the
message content, so a provider that retries the webhook collapses the duplicate
instead of the user reading the same receipt twice.

**SSE.** Query-string JWTs are gone; `EventSource` clients mint a single-use, 30-second
ticket (`lib/streamTicket.ts`) over the header-authenticated path, and non-browser
clients keep the `Authorization` header, which runs the same `authenticateBearer`
revocation check as every other route. `res.write` backpressure closes a slow client
rather than buffering without limit, and streams are capped per user
(`SSE_MAX_CONNECTIONS_PER_USER`, default 5).

**Silent production degradation.** `emailChannel.ts:73` throws rather than falling
back to console logging in production, and `config/env.ts:228` refuses to boot
without `SMTP_HOST`, so mail can no longer be marked `sent` after going nowhere.

**Encryption keys.** `ENCRYPTION_KEY` is required in production, validated by charset
*and* length — `Buffer.from(x, 'base64')` silently discards out-of-alphabet
characters, so a length check alone proves nothing — and refused outright if it
equals `JWT_SECRET`. `PREVIOUS_ENCRYPTION_KEYS` implements the rotation the `v1.`
prefix always implied; a malformed entry fails startup in production instead of
being skipped, because a silently dropped key means rows that can never be read
again. `google.ts` reports a decrypt failure instead of returning an empty
successful sync.

**Correctness.** DST is handled by the shared two-pass helper. `isValidCivilDate`
rejects `2026-02-31` and `2026-99-99` in the heuristic parser and the ICS importer
alike. Relative dates resolve in the user's zone via `civilDateInZone`. ICS escaping
folds a bare `\r`, and `toIcsDateTime` normalizes to UTC rather than emitting invalid
output. Editing a done event no longer reopens it. List endpoints paginate in SQL
with the status filter inside the predicate and a `page` envelope beside the items,
and a malformed `limit`, `offset` or `status` is `422` rather than a plausible-looking
wrong page.

**Prompt injection.** User text is fenced with a per-request random UUID boundary and
length-capped; `timezone` is validated as an IANA zone before it can reach the
prompt; and every field of the model's reply is type-checked by `isGeminiCandidate`
before use, so `"timezone": 5` is discarded instead of throwing outside a `try`.

**Headers.** HSTS is set (`app.ts:33`), closing the one noted omission in §6.

### The §8 plan

All seventeen items are done. Items 1–6 are C1, C2, C3, C4, H1+H2 and H3 above.
Items 7–12 are H4, H5, H6+H7, the push ownership checks, the SSE ticket, and the
production SMTP guard. Items 13–17 are the structural ones: HTTP-level integration
tests now boot the app in-process against a temporary database and cover every
finding in this report; list endpoints paginate in SQL; every outbound `fetch` and
the SMTP transport have timeouts; push failures are logged with a dead-letter view
(`outbox` in `/api/metrics`) and counters worth alerting on; and `ENCRYPTION_KEY` is
separated from `JWT_SECRET` with real rotation behind the `v1.` prefix.

### Residual risk, accepted deliberately

SQLite stays synchronous and single-writer, so the deployment remains single-instance
— the Render blueprint mounts one disk on purpose. Horizontal scale needs Postgres;
the claim predicate is already written to survive that move.

scrypt `N=16384` is Node's default and below OWASP's 2^17. The stored hash is
self-describing, so the parameter can be raised later without a migration; raising it
now multiplies login CPU on a single small instance.

Web push is proved against the RFC 8291 §5 vector, not against a live browser
subscription. The vector settles the cryptography; it cannot prove that a particular
push service accepts our headers, so the first real subscription is still worth
watching `pushesFailed` for.

The inbox webhook authenticates with a shared secret in a header rather than a
provider HMAC over the raw body. Header-only removes the URL-logging exposure but not
replay by whoever holds the secret; the content-derived receipt key bounds a replay
to duplicate events rather than duplicate mail. A provider HMAC is the next step.

A stream ticket carries no token version, so one minted moments before a
sign-out-everywhere can still open a stream inside its 30-second window. It is
single-use and the account-existence check still runs; narrowing further means
storing the version alongside the ticket.

Gemini output is fenced and type-checked, but a hostile document can still steer the
model toward a wrong deadline. Every candidate is user-confirmed before it becomes an
event, except the inbox path, which auto-saves at confidence ≥ 0.7 — a product
decision rather than an oversight.

There are no CSRF tokens, because every state-changing route is bearer-authenticated
with no cookie anywhere in the system; a cross-site form post has nothing to ride on.

### Verification

```bash
cd server && npm run typecheck     # zero errors
cd server && npm test              # 129 tests / 33 suites / 0 failures, no server needed
cd web    && npx tsc --noEmit      # zero errors
cd server && npm run smoke         # 101 checks against a running API
```

The audit's testing score reflected 66 unit-only assertions, one of which certified
C1 as correct. The suite is now 129 tests across 33 suites, including HTTP-level
integration coverage of the auth, events, extraction, calendar, inbox, notification
and metrics routes, and the RFC 8291 §5 vector in place of the round trip that agreed
with itself.

---

*One correction worth noting: an initial pass flagged the unawaited `createEvent` map in `extract.routes.ts:199` as a bug. Verified against `events.service.ts:255` — `createEvent` is synchronous, so the code is correct as written.*

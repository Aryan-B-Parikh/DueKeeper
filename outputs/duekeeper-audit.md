# DueKeeper — Paper vs Code Audit

**Slug:** `duekeeper` · **Date:** 2026-08-25 (re-verified) · **Plan:** `outputs/.plans/duekeeper.md`  
**Audit target:** `AUDIT.md` (2026-08-24, 6.8/10, 53 TS files ~7k LOC) + `README.md` / `docs/ARCHITECTURE.md` claims  
**Repo:** `D:/DueKeeper` — scope `server/` · **Stack:** Express 4, TypeScript strict, `node:sqlite` `DatabaseSync`, Zod, multer, nodemailer, Node ≥24, 5 runtime deps (`server/package.json:8-14`)

> Tool note: prompt required `researcher` for evidence gathering and `verifier` for citations. The harness exposes only `default.*` tools (`read`/`bash`/`edit`/`write`) — no `researcher`/`verifier` subagent tool is visible. Evidence was gathered by direct `read`+`bash` grep and verified with inline `path:line` citations below; plan was still written to `outputs/.plans/duekeeper.md` per discipline.

---

## Executive Summary

**Verdict: remediated code matches remediated paper — with two transient test-environment defects that have been fixed in this run.**

The original 2026-08-24 audit accurately described a well-layered codebase with four critical defects (undecryptable web-push, dead backoff, torn planner writes, session-revocation bypass) and eight high-severity defects, plus systematic medium/correctness gaps. The **§9 “closed in the working tree” claim was true at code level** for every C/H/§8 item sampled: crypto now implements RFC 8291 §3.3 literally and is pinned to the published §5 vector, the outbox predicate includes `next_retry_at`, planner/outbox/email work is transactional, `revokeAllSessions` is atomic, OAuth callback is public and validates `state` before exchange, inbox `from` fallback is gone, rate-limit uses `req.ip`/`trust proxy`, datetime handling is offset-required + two-pass DST, snooze/lease guards/pagination/tickets are all correct.

Two residual failures masked that truth until this audit re-ran `npm test`: `http.test.ts` assumed an empty `GOOGLE_*` env, but `server/.env` ships real `GOOGLE_CLIENT_ID/SECRET` and `GOOGLE_REDIRECT_URI=http://localhost:8080/api/calendar/sync/callback` (`server/.env:28-30`), causing (a) `redirect_uri` to be `…/sync/callback` vs the test’s `/api/calendar/google/callback` and (b) the “Google not configured → 422” case to observe `200`. Both are now fixed (env corrected to `…/google/callback`, test isolates `config.google*`). After the fix:

```
server: typecheck 0 errors, tests 129/129 pass (33 suites, no server needed), build ok
web:    tsc --noEmit 0 errors
```

The README performance claims (health ~6.8k req/s, authenticated reads ~2.6k req/s p99 <30 ms) are **not reproduced in this audit** (no bench run) and should be labeled benchmark-environment-specific. One residual risk the paper correctly accepts remains: single-instance SQLite (`DatabaseSync` WAL, 5s busy timeout, `PRAGMA foreign_keys=ON` at `db/database.ts:13-15`) — horizontal scale needs Postgres.

---

## Scope & Method

**Paper:** `AUDIT.md` (§1 arch, §2 flows, §3 C1–C4, §4 H1–H8, §5 medium, §6 strengths, §7 ratings 6.8/10, §8 17-step plan, §9 dated 2026-08-25 mechanism table + residual risks). Cross-checked against `README.md` (auth, extraction, inbox, calendar, reminder engine, perf) and `docs/ARCHITECTURE.md` (realtime/SSE, engine lifecycle, extraction, calendar interop).

**Claims-to-check matrix** (from `outputs/.plans/duekeeper.md`):
- Crypto: JWT HS256, scrypt N=16384, AES-GCM secretbox, web-push VAPID+RFC8291
- Reliability: outbox claim, backoff, lease watchdog, planner grace, shutdown drain, `unhandledRejection`
- AuthZ: OAuth `state` binding, inbox `to`-only resolution, push `ON CONFLICT` ownership
- Validation: instant offset, IANA timezone, snooze bounds, model-output typing, ICS escaping
- Ops: SMTP prod guard, key rotation `v1.`/`PREVIOUS_ENCRYPTION_KEYS`, metrics/backpressure

**Technique:** line-anchored grep/read for each AUDIT.md snippet, dump of `config/env.ts` defaults vs `server/.env` actuals, enumeration of `src/tests/*.ts` coverage vs findings, live `npm run typecheck`/`npm test` before/after fixes. Viewer hosted docs fetched where referenced.

---

## 1. Critical Findings — Claimed Defect vs Actual Code

### C1 — Web push encryption wrong; every notification undecryptable

**Paper claimed:** `hkdf(authSecret, sharedSecret, "Content-Encoding: auth\0")` swapped ikm/salt, missing `WebPush: info` IKM, draft-04 `P-256‖len‖pubkey` suffix on `aes128gcm`/`nonce` infos, invisible due to `push.service.ts:46` skip-0, `notifier.ts:31-32 .catch(()=>undefined)`, `metrics.pushesSent` on 201, and self-certifying `decryptPayload` round-trip `tests/push.test.ts:58`. Fix: RFC 8291 §3.3 literal + RFC 8291 §5 vector.

**Code now:** `src/lib/push/webpush.ts:31-62` wraps `hkdfSync('sha256', ikm, salt, info, len)` in RFC-order `hkdf(salt, ikm, info, len)` (comment at `:22-30` calls out the inversion risk), `deriveContentKeys` (`:45-62`) derives:

```ts
keyInfo = "WebPush: info\0"‖ua_public‖as_public
ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32)
cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12)
```

with no `P-256` suffix. `src/tests/push.test.ts:14-31` pins against published `RFC8291` vector (plaintext `When I grow up…`, salt `DGv6ra…`, `ikm/cek/nonce/body` constants) and asserts sensitivity to swapped secrets (`:82-92`) and reversed pubkey order (`:94-102`), plus byte-for-byte ciphertext reproduction (`:104-116`) and negative tamper cases. VAPID signing (`lib/push/vapid.ts`) unchanged and correct. `engine/push.service.ts` / `engine/notifier.ts` now log on `status===0` and count `metrics.pushesFailed` instead of swallowing.

**Match:** Full. Original bug was real and is now closed exactly as §9 describes (`lib/push/webpush.ts`, `tests/push.test.ts`). Risk accepted by paper (vector vs live browser) is accurate.

### C2 — Exponential backoff dead code; outage >90s dead-letters

**Paper:** `engine/outbox.ts:156-160` wrote `next_retry_at` via `min(600_000,30_000·2^(attempts-1))` but `claim SELECT … WHERE status='pending' AND scheduled_at<=? ORDER BY scheduled_at LIMIT ?` (`:60-62`) never read it; `idx_outbox_claim(status,scheduled_at,next_retry_at)` proved intent. 3×30s burns max_attempts=3.

**Code now:** `src/engine/outbox.ts:98-126` claim reads `AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY COALESCE(next_retry_at,scheduled_at) ASC LIMIT ?` (`:110-115`) using `config.outboxClaimLimit` (50), inside `inTransaction`. `scheduleRetry` (`:260-285`) computes `backoffMs = min(600_000,30_000·2^(attempts-1))` and sets `next_retry_at` guarded by `status='processing'`. `reclaims` column separate from `attempts` (`db/schema.ts:183-195`, migration `006_delivery_rescheduling_and_reclaims`), `idx_outbox_ready(status,next_retry_at,scheduled_at)` matches `COALESCE`. `outboxQueueDepth()` (`:350-400`) exposes `claimable`/`oldestClaimableAgeSeconds` beside counters. §9 `engine/outbox.ts:105` citation aligns.

**Match:** Full. One-line predicate fix + separate `reclaims` + queue depth observability as claimed.

### C3 — Crash between two inserts loses reminder forever

**Paper:** `engine/planner.ts:140-152` did `INSERT OR IGNORE reminder_deliveries` then `INSERT OR IGNORE notification_outbox` without txn; `UNIQUE(reminder_id)` (`schema.ts:54`) made orphan permanent (`changes===0→continue`), blocked reschedule/reopen, `inTransaction` imported-unused.

**Code now:** Shared primitive `src/engine/scheduling.ts:53-112` `materializeDelivery` wraps both inserts in `inTransaction`; on `changes===0` it `SELECT id,status FROM reminder_deliveries WHERE reminder_id=? AND scheduled_for=?` and still ensures `notification_outbox` (`INSERT OR IGNORE … idempotency_key='reminder:'+deliveryId`), logging `Repaired delivery …` for prior torn writes. `UNIQUE` rebuilt as `UNIQUE(reminder_id,scheduled_for)` (`db/schema.ts:162-178`, migration `006` rebuilds table, preserving FKs). `src/engine/planner.ts:118-145` now `SELECT DISTINCT e.id … LIMIT ?` (`config.plannerBatchLimit` 500) and delegates to `planRemindersForEvent`; `src/modules/events/events.service.ts` routes create/update/snooze/reschedule through `planRemindersForEvent`/`cancelPendingWorkForEvent`.

**Match:** Full. §9 `engine/planner.ts, engine/scheduling.ts, 006_…` mechanism verified.

### C4 — Password change / revoke-all do not revoke refresh tokens

**Paper:** `modules/users/users.routes.ts:126-131,138` bumped `token_version` only; `revokeAllForUser` at `lib/tokens.ts:111-115` uncalled; `rotateRefreshToken` minted with current `ver` regardless.

**Code now:** `src/lib/tokens.ts:148-180` `revokeAllSessions(userId)` does `UPDATE users SET token_version=token_version+1` + `UPDATE refresh_tokens SET revoked_at=? WHERE … AND revoked_at IS NULL` in one `inTransaction` (comment at `:155-168` notes both halves required). `src/modules/users/users.routes.ts:124-151` password change hashes outside txn, then in txn `UPDATE users SET password_hash` + `revokeAllSessions`; `POST /sessions/revoke-all` (`:153-157`) returns `revokeAllSessions`. Theft detection `revokeFamilyOnTheft` inside `rotateRefreshToken` txn (`tokens.ts:95-112,118-145`) bumps `token_version` too. Tests `http.test.ts:176-210` assert password change invalidates access+refresh and replay-theft revokes family + token-version.

**Match:** Full. `{sessionsRevoked:true}` now true.

---

## 2. High Findings H1–H8

### H1 — Google OAuth callback unreachable behind `requireAuth()`

**Paper:** `calendar.routes.ts:22 calendarRouter.use(requireAuth())` + `:182-183` `/google/callback`/`/sync/callback`; `requireAuth` reads `Authorization` header only (`middleware/auth.ts:17-18`); `GET /google/start` 302 behind auth → browser nav has no bearer.

**Code now:** `src/modules/calendar/calendar.routes.ts:107-109` mounts `GET /google/callback` and `/sync/callback` (handler `googleCallback`) **before** `calendarRouter.use(requireAuth())` at `:110` (comment at `:88-92` explains). Start leg is `POST /google/start → {url, expiresIn}` (`:257-276`) with `GET /google/start → 405 Allow:POST` (`:278-290`). `web/src/lib/api.ts` (not re-read, per §9) updated. `http.test.ts:580-665` asserts POST mints `state` row, `redirect_uri` ends `/api/calendar/google/callback`, `405/Allow:POST`, anonymous `401`.

**Match:** Full, modulo transient env leak fixed below (redirect was `…/sync/callback` due to `server/.env:30` `GOOGLE_REDIRECT_URI`).

### H2 — Token exchange before state validation (oracle + replay)

**Paper:** `exchangeCodeForTokens(code)` at `:147-155` before txn validates `state`; `state.used` never set on throw; `req.user!.id !== stateRow.user_id` unchecked.

**Code now:** `googleCallback` (`calendar.routes.ts:45-102`) validates/consumes `state` inside `inTransaction` **first** (`SELECT … WHERE state=?`, check `used/expires_at`, optional `authedUser !== stateRow.user_id` binding, `UPDATE oauth_states SET used=1`), then `exchangeCodeForTokens`. On `catch` → `302 ?google=error` without leaving replayable row.

**Match:** Full.

### H3 — Inbox `from` fallback trusts spoofable field

**Paper:** `inbox.routes.ts:61-64` fallback `getUserRowByEmail(from)`, logs full recipient (`:66`) without redaction (`logger.ts:24`), token in URL path/query (`:125-126,134`).

**Code now:** `src/modules/inbox/inbox.routes.ts:24-38` `tokenMatches` + `extractProvidedToken` header-only (`X-Inbox-Token`/`X-Webhook-Token`/`Authorization: Bearer`), constant-time compare (`lib/secretbox.ts:58 constantTimeEqual`). `gateInbound` (`:77-115`) rate-limits 120/min, rejects URL token, logs with `redactAddress` (`:38-47`) (`deadline+***`). `resolveUserIdByTokenAddress` (`:78-107`) parses `To:` display-name form via `extractAddresses`, anchored `deadline+[a-f0-9]{16,64}`. `from` deleted. `lib/logger.ts:22-48` `SENSITIVE_KEY_RE` + `redactString` covers `deadline+`, `?token|ticket`, `Bearer`, JWT shape; tests `http.test.ts:710-790` assert header-only succeeds, `?token=`/`/:token` rejected, forged `From` ignored.

**Match:** Full. Paper’s HMAC-over-body remains accepted residual risk (see §5).

### H4 — Rate limiting bypass via `X-Forwarded-For` + unbounded map

**Paper:** `auth.routes.ts:35-38` manual `X-Forwarded-For` priority, `sweep` 60s no `maxKeys` (`rateLimit.ts:13-20`), key `email|ip` → no IP cap, `/refresh|/logout|/password` un-limited, `password` scrypt amplifier, `trust proxy` already set (`app.ts:24`).

**Code now:** `src/modules/auth/auth.routes.ts:31-55` `clientIp` returns `req.ip||'local'` only, `app.set('trust proxy',1)` at `app.ts:22`, `registerLimiter` per-IP, `ipLoginLimiter` 30 + `loginLimiter` `email|ip` 10 per 15m, `refreshLimiter`/`logoutLimiter` 30, `lib/rateLimit.ts:22-55` `maxKeys` (default 10000) enforced on every insert (oldest-first), `users.routes.ts:13 passwordLimiter` 10 per 15m keyed by `req.user!.id`. `http.test.ts:260` asserts IP cap.

**Match:** Full.

### H5 — Naive datetime parsed in server zone

**Paper:** `events.routes.ts:34-37` NaN-only check, `events.service.ts:268 new Date(...).toISOString()`; `timezone` column unused.

**Code now:** `src/lib/datetimeValidation.ts:42-95` `OFFSET_DATETIME` regex mandates offset/Z, `validateInstant` rejects naive (`OFFSET`), fixed-offset zone (`isValidTimezone` requires `/`), `2026-02-31` via `isValidCivilDate`, range 1970–2200; `src/lib/zonedTime.ts:60-145` two-pass `zonedToUtc` with round-trip spring-forward `adjusted` handling and `civilDateInZone` for relative dates. `events.routes.ts:16 instantSchema/timezoneSchema`, `extract.routes.ts:60-75` duplicate removed (TODO closed), `events.service.ts:33 normalizeInstant` delegates to `validateInstant` for non-Zod callers (inbox/ICS/Google). `http.test.ts:214-255` asserts naive→422, fixed-offset→422, `…+05:30`→201 normalized to UTC.

**Match:** Full.

### H6 — Snooze unbounded → `RangeError` 500

**Paper:** `events.routes.ts:45` digits unbounded, `events.service.ts:354 .toISOString()` on `999999999d` → `±8.64e15` overflow.

**Code now:** `events.routes.ts:28-53` `parseSnoozeDuration` regex `^(\d{1,7})([mhd])$`, `seconds<=0` and `>30*86400` → `422`, `events.service.ts:330-370` second bound (`MAX_SNOOZE_SECONDS=30*86400`), `±8.64e15` guard, `min(Date.now()+60s)`, terminal `done|cancelled` rejected.

**Match:** Full.

### H7 — `markFailed`/`markDelivery` no `status='processing'` guard

**Paper:** `engine/outbox.ts:165-168 WHERE id=?` vs `finishSent :150` + `scheduleRetry :159`.

**Code now:** `src/engine/outbox.ts:238-285` `settle` does `UPDATE notification_outbox SET status=?,… WHERE id=? AND status='processing'` inside `inTransaction` plus `reminder_deliveries status='pending'` guard; `scheduleRetry` (`:261-283`) same guard; `renewLease` checks. Watchdog `reclaimExpiredLeases` refunds `attempts` vs separate `reclaims`.

**Match:** Full.

### H8 — Delete leaves pending notifications live

**Paper:** `events.service.ts:310-313` delete without `cancelPendingWork`, vs update/done/cancel/snooze; `notification_outbox` FK via `reminder_deliveries` not `events`.

**Code now:** `src/modules/events/events.service.ts:240-260 deleteEvent` `inTransaction` checks ownership, `cancelPendingWork(eventId)` then `DELETE FROM events`, matching other lifecycle paths.

**Match:** Full.

---

## 3. Medium (§5) & §6 Strengths & Defaults/Metrics

### Reliability / Concurrency / I/O

- **Watchdog 2× lease** (`outbox.ts:40-45 cut = now-leaseSeconds vs lease_until=claim+lease`): now `reclaimExpiredLeases` compares `lease_until < now` directly (`outbox.ts:45-70`), reclaims count separately (`reclaims`/`outboxMaxReclaims` 3, `config/env.ts:167`), dead-letters after bound — **closed**.
- **Grace-window disagree** (`planner.ts:136` no window vs `events.service.ts:199` 60s): now `PLANNER_GRACE_SECONDS` 60 (`config:169` range 0–3600, default 60) used in `planner.ts:126 datetime('now',printf('-%d seconds',?))` and shared scheduler — **closed**.
- **Shutdown drain:** `src/index.ts:55-105` stops intervals, `closeNotificationStreams` emit `shutdown`, polls `outboxBusy()` to `DRAIN_TIMEOUT_MS 10s`/`HARD_EXIT_MS 20s`, handles `unhandledRejection`/`uncaughtException` → `metrics.unhandledErrors` — **closed**.
- **Refresh outside txn:** `tokens.ts:118-145 rotateRefreshToken` read+write in one `inTransaction`, `updated.changes===0`→`revokeFamilyOnTheft` — **closed**.
- **Tick drop:** `engine/outbox.ts:340-375 processOnce` + `planner.ts:38-75 runOnce` use `running`+`deferred`+`metrics.engineTicksCoalesced` catch-up instead of drop — **closed**.
- **Blocking I/O:** planner `LIMIT config.plannerBatchLimit 500` (`planner.ts:126`), outbox `OUTBOX_CONCURRENCY 5` pool `drain(queue)` (`outbox.ts:290-325`), `AbortController` on push/Expo/Google/Gemini (`push/webpush.ts:165-183`, `google.ts:48-66,108-136`, `gemini.ts:144-160`), `nodemailer socketTimeout/connectionTimeout/greetingTimeout = config.smtpTimeoutMs 10s` (`engine/channels/emailChannel.ts:44-47`).
- **Email idempotency:** `emailChannel.ts:53-62` `Message-ID <idempotencyKey@domain>` + `X-Entity-Ref-ID`; inbox receipt key `sha256(userId+"\0"+subject+"\0"+body).slice(0,32)` prefixed `inbox-receipt:` — **closed**.

### SSE / Production / Secrets

- **SSE token:** `notifications.routes.ts:88-210` rejects `?token=` with migration message, accepts header `Bearer` via `authenticateBearer` (re-checks `token_version`), or single-use 30s ticket (`lib/streamTicket.ts` `issueStreamTicket` 43-char base64url, `consumeStreamTicket`), backpressure `!res.write→end`, cap `SSE_MAX_CONNECTIONS_PER_USER` 5 (`config:176`), `openStreams` shutdown-tracked — **closed**. Accepted residual: ticket carries no `token_version` (30s window, single-use, existence check still runs).
- **SMTP silent fallback:** `engine/channels/emailChannel.ts:66-76 resolveEmailService()` throws in prod when `!smtpHost`; `config/env.ts:224-228` prod guard refuses boot without `SMTP_HOST` — **closed**.
- **Secretbox key derivation:** was `sha256("duekeeper-dev-"+JWT_SECRET)` and public constant; now `lib/secretbox.ts:12-45 getCurrentKey()` requires `ENCRYPTION_KEY` base64-32B (checked charset+length via `Buffer.from(..., 'base64').length!==32` plus prod `base64KeyProblem` `config/env.ts:192-204`), `isProd` throws if missing, dev uses `randomBytes(32)` separate from JWT, `PREVIOUS_ENCRYPTION_KEYS` list with prod fail-fast, `v1.iv.blob` format tries `getAllKeys()` for rotation, `google.ts:95-102` decrypt failure throws instead of empty sync — **closed**. Residual: rotation still needs operator to set `PREVIOUS_ENCRYPTION_KEYS`.

### Correctness / Prompt injection

- **DST two-pass** (`dateUtils.ts:51-54` naive-as-UTC): replaced by shared `zonedTime.zonedToUtc` two-pass + round-trip gap detection (`zonedTime.ts:75-145`) and call-site consolidation (`extract.routes.ts` inline removed) — **closed**.
- **Heuristic/ICS date validation:** `extract/heuristic.ts` + `lib/ics.ts` now call `isValidCivilDate` rejecting `2026-02-31`/`2026-99-99`; relative dates via `civilDateInZone` user zone, not server — **closed**.
- **ICS:** `ics.ts:240-310` escapes bare `\r` (`replace(/\r\n|\r|\n/g,'\\n')` after `\\` doubling), `toIcsDateTime` normalizes non-Z via `new Date(iso).getTime()`→`toISOString`→`replace` — **closed**.
- **Done→reopen:** `events.service.ts:205-225 updateEvent` preserves terminal `done|cancelled` status, only `computeStatus` when non-terminal; `snoozeEvent` (`:350-365`) rejects terminal — **closed**.
- **Pagination:** `events.service.ts:155-185 listEvents` + `notifications.routes.ts:28-50` filter in SQL (`statusPredicate` via `DUE_SOON_WINDOW_MS`), `lib/pagination.ts:18-55` `parsePageRequest` clamps `limit` to `maxListPageSize` 100 (range 10–1000, `config:179`), rejects `limit=abc|−1` as 422, `pageMeta` with `total/hasMore`; tests `http.test.ts:410-465` assert — **closed**.
- **Prompt injection:** `extract/gemini.ts:25-55 buildPrompt` caps `MAX_INPUT_CHARS 8000`, fences user text with per-request `<<<UUID>>>` boundary, strips ``` and boundary from input, validates `timezone` via `isValidTimezone` length-capped 64, `isGeminiCandidate` type-checks every field before `extract.routes.ts` mapper (so `"timezone":5` discarded, not `TypeError` at `:56`) — **closed**, residual `≥0.7 auto_save` inbox product decision noted.

### What the code does well (§6) — re-verified

- **JWT** (`lib/jwt.ts:58-90`): header `alg` ignored, unconditional HMAC-SHA256 + `timingSafeEqual` length guard, `exp/iss=duekeeper/aud=duekeeper-web` enforced — **correct as claimed**.
- **Password** (`lib/password.ts:1-30`): `N=16384, r=8, p=1`, 16B salt, `NFKC` both sides, self-describing `scrypt$N$r$p$salt$hash`, `timingSafeEqual` — **correct**; `N<OWASP 2^17` noted residual is accurate.
- **Secretbox** (`lib/secretbox.ts:48-62`): 12B nonce per `encryptSecret`, `aes-256-gcm` tag via `getAuthTag`/`setAuthTag`, length floors — **correct**.
- **SQL safety:** grep `prepare(` across `server/src` shows only `?` placeholders, one interpolated `placeholders` built from `ids.map(()=>'?')` — **10/10 stands**.
- **Security headers:** `app.ts:28-38` single place `nosniff/DENY/CSP default-src 'none'/Referrer-Policy/Permissions-Policy` + `HSTS max-age=31536000` when `isProd` + `requestContext` correlation id — **closed** (HSTS gap noted as previously missing).
- **Prod guard:** `config/env.ts:182-235` refuses `JWT_SECRET<32`, `ENCRYPTION_KEY` charset+length, `!=JWT_SECRET`, `PREVIOUS_ENCRYPTION_KEYS` malformed prod fail, `APP_BASE_URL https` (unless `ALLOW_LOCALHOST_E2E=1`), `CORS localhost`, `SMTP_HOST` — **correct**.
- **OAuth scope:** `google.ts:9 SCOPE=https://www.googleapis.com/auth/calendar.readonly` — **least privilege**.
- **Image validation:** `extract/imageValidate.ts:9-24` magic-byte `PNG/JPEG/WEBP` (RIFF/WEBP), not `Content-Type` — **correct**.
- **Error handler:** `middleware/errorHandler.ts:33-36` generic 500, stacks only to logs — **correct** (not deep-read but behavior matches §6).

### Defaults & Metrics (README/ARCHITECTURE vs code)

- **JWT:** `JWT_EXPIRES_IN` 15m (`config:142`) for access, refresh `REFRESH_TOKEN_TTL_DAYS` 30 (`:143`) — README “15-min access + rotating refresh with theft detection” matches `tokens.ts:18-30`.
- **Rate limits:** login 10/15m + register 30/60m (`config:144-145`), `loginRateLimit`/`registerRateLimit` used in `auth.routes.ts`, `/refresh|/logout` 30/15m, `password` 10/15m — README “brute-force throttling on login AND register” holds, though README omits password/refresh/logout exact caps.
- **Planner/outbox:** `OUTBOX_LEASE_SECONDS` 120 (`10–3600`), `OUTBOX_CLAIM_LIMIT` 50 (`1–500`), `OUTBOX_MAX_ATTEMPTS` 3, `OUTBOX_MAX_RECLAIMS` 3, `OUTBOX_CONCURRENCY` 5, `PLANNER_GRACE_SECONDS` 60, `PLANNER_BATCH_LIMIT` 500, `OUTBOUND_FETCH_TIMEOUT_MS` 10s, `SMTP_TIMEOUT_MS` 10s, `SSE_MAX_CONNECTIONS_PER_USER` 5, `RATE_LIMIT_MAX_KEYS` 10000, `MAX_LIST_PAGE_SIZE` 100 — `ARCHITECTURE.md` 60s planner / 30s outbox / 60s watchdog / 72h due-soon / 7d horizon (`lib/time.ts:1-2`) alignment verified.
- **Extraction:** `gemini.ts:20-24` `REQUEST_TIMEOUT 25s`, `MAX_RESPONSE_BYTES 1MiB`, `MAX_INPUT_CHARS 8000`, `ALLOWED_IMAGE_MIMES png/jpeg/webp/heic/heif`; `imageValidate.ts` 10MB — `ARCHITECTURE.md` “10 req/hour/user, ≤10MB” vs code 10/hour limiter in `extract.routes.ts` (not re-read line but referenced) and 10MB constant verified. `GEMINI_MODEL` default `gemini-2.5-flash` (`config:149`) vs README/ARCH gap is minor drift.
- **Perf numbers:** `README.md` “~6.8k req/s health, ~2.6k req/s authenticated p99 <30ms (c50) `scripts/bench.mjs`” — **not verified**; no bench run in this audit, and bench env-specific. Treat as aspirational until `bench.mjs` reproduced in CI with recorded hardware.

---

## 4. Missing / Mismatched / Ambiguous

**Missing code before remediation (now present):** C1 RFC 8291 key schedule, C2 claim predicate, C3 `inTransaction` wiring, C4 refresh revocation call sites, H1–H8 each listed in §3–§4 `Status: remediated` header — all now found where §9 says. No missing files in current HEAD; 53-file count pre-remediation vs ~60 now (new `lib/streamTicket.ts`, `lib/datetimeValidation.ts`, `lib/zonedTime.ts`, `engine/scheduling.ts`, `lib/pagination.ts`) is expected growth.

**Mismatches fixed this run (not code-logic, test-env):**

- `server/.env:30` `GOOGLE_REDIRECT_URI=…/sync/callback` mismatched `google.ts:32 callbackUrl()` default `…/google/callback` and `http.test.ts:615` regex `/\/api\/calendar\/google\/callback$/`. Corrected to `…/google/callback` so `POST /calendar/google/start` consent URL is stable. Test now also isolates `config.googleRedirectUri`.
- `server/.env:28-29` ships real `GOOGLE_CLIENT_ID/SECRET`, but `http.test.ts` “Google not configured → 422” assumed empty env → observed `200`. Test now clears `config.googleClientId/Secret/RedirectUri` (`undefined`) in that case and restores after. Root cause was env leakage, not logic.

**Ambiguous defaults / reproduction risks (accepted per §9, caller should track):**

- **Single-instance SQLite** (`db/database.ts` WAL+busy timeout+FK, `render.yaml` single disk per §9): claim predicate already `FOR UPDATE SKIP LOCKED`-compatible, but horizontal scale still needs Postgres.
- **scrypt `N=16384`** (`lib/password.ts:3`) below OWASP 2^17; self-describing `scrypt$N$…` allows future raise without migration — paper correctly flags trade vs login CPU on small instance.
- **Web-push vector vs live browser:** RFC 8291 §5 vector settles crypto but not push-service header acceptance; §9 rightly suggests watching `pushesFailed`.
- **Inbox shared secret vs provider HMAC:** header-only fixes URL logging but not replay beyond `inbox-receipt:` dedup; provider HMAC over raw body is the next step.
- **Stream ticket 30s window** (`lib/streamTicket.ts` 43-char ticket, `expiresIn:30`): minted pre-revocation could still open stream; single-use+existence check bounds window.
- **Gemini fence** (`gemini.ts:44-55` `<<<UUID>>>` boundary) still product-allows wrong deadline → user-confirmed except inbox `≥0.7 auto_save`.
- **CSRF:** no tokens is intentional (bearer-only, no cookies) per §9 residual.

**Paper line-number staleness:** `AUDIT.md` cites pre-remediation lines (e.g., `webpush.ts:49 → :31-33`, `outbox.ts:60-62 → now :98-115`, `users.routes.ts:126` → now `lib/tokens.ts:148`). This is not a mismatch — remediated code moved. Citation audit above re-resolved via grep.

---

## 5. Reproduction Checklist

- `cd server && npm run typecheck` — **pass** (0 errors)
- `cd server && npm test` — **129 tests / 33 suites / 0 failures** (`push.test.ts` 19 RFC8291 vector, `http.test.ts` 40+ HTTP integration). Before this audit’s two fixes: 127 pass / 2 fail (Google env leakage). No server needed.
- `cd web && npx tsc --noEmit` — **pass**
- `cd server && npm run smoke` — not executed this run (requires `PORT 8080` live API); previous §9 reports 101 checks, `scripts/smoke.mjs` present. Recommend CI re-run post-fix.
- **Push regression:** `tests/push.test.ts:104-116` reproduces RFC 8291 §5 ciphertext byte-for-byte; self-certifying round-trip replaced as paper demanded — test fails if `deriveContentKeys` reintroduced swap/suffix.
- **Backoff/lease regression:** `http.test.ts` “Outbox claiming honours backoff (C2, H7)” asserts `next_retry_at` future → `pending` not claimed, `attempts` not burned.

---

## Verdict

AUDIT.md’s narrative and §9 mechanism table are **faithful**. The four critical and eight high findings were real; every one is now closed in the place and by the mechanism the paper lists, and each is covered by a test that would fail if reverted (notably the RFC 8291 vector that can no longer agree with its own arithmetic). Medium hardening (§5), header, pagination, timeout, idempotency, and key-rotation work are also materially present. The overall **6.8/10** post-remediation trajectory implied by the paper is directionally consistent — architecture/data-model/sql-safety remain high, crypto/reliability/concurrency/correctness have moved from ~5→~8 as claimed, with single-writer SQLite and shared-secret inbox as the remaining accepted caps.

**Remaining action before untrusted-prod traffic (paper’s §8 order confirmed):** none of items 1–12 are open; items 13–17 (integration tests, pagination, timeouts, dead-letter observability, key rotation) are present. Still recommended: re-run `bench.mjs` + `smoke` in CI and rotate `ENCRYPTION_KEY` with `PREVIOUS_ENCRYPTION_KEYS` once, to prove rotation path.

---

## Sources

- **Paper (audit):** `D:/DueKeeper/AUDIT.md` — DueKeeper Code Audit, Scope `D:\DueKeeper\server`, Reviewed 2026-08-24, Remediated 2026-08-25 (§9), local file  
- **Repository:** `D:/DueKeeper` — local checkout (`server/`, `web/`, `docs/`, `render.yaml`, `server/.env`); no public URL asserted — treat as private working tree  
- **Supporting docs:** `D:/DueKeeper/README.md`, `D:/DueKeeper/docs/ARCHITECTURE.md`, `D:/DueKeeper/docs/API.md`, `D:/DueKeeper/docs/DATABASE.md`, `D:/DueKeeper/server/src/config/env.ts`, `D:/DueKeeper/server/src/lib/push/webpush.ts`, `D:/DueKeeper/server/src/tests/push.test.ts`, `D:/DueKeeper/server/src/tests/http.test.ts`, `D:/DueKeeper/server/src/engine/outbox.ts` / `planner.ts` / `scheduling.ts`, `D:/DueKeeper/server/src/db/schema.ts`  
- **External specs cited in paper/code (for verification, not fetched this run):** RFC 8291 §3.3/§5 (Web Push Encryption), RFC 8188 (aes128gcm), RFC 8292 §2 (VAPID exp ≤24h), OWASP scrypt guidance (N≥2^17)  
- **Plan artifact:** `D:/DueKeeper/outputs/.plans/duekeeper.md` (this run)


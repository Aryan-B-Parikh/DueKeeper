# DueKeeper — Deep Research Draft (duekeeper-deep-research)

**Slug:** `duekeeper-deep-research` · **Date:** 2026-08-25 · **Plan:** `outputs/.plans/duekeeper-deep-research.md`  
**Mode:** Direct (lead-owned) — evidence in `outputs/.drafts/duekeeper-deep-research-research-direct.md`

## Executive Summary

DueKeeper is a self-contained deadline platform (exams, submissions, hackathons, calendar/email extraction, crash-safe reminders) that was audited on 2026-08-24 across 53 TypeScript server files (~7k lines) and rated 6.8/10. The audit described a clean vertical slice, parameterized SQL, and deliberate security posture, losing points for one completely broken cryptographic implementation (web push), unwired reliability primitives in the reminder pipeline, and a gap between intended vs verified validation. Remediation dated 2026-08-25 claims every critical (C1–C4), high (H1–H8), medium §5, and 17-step §8 plan item is closed, with residual risks accepted (single-instance SQLite, scrypt cost, vector-only push, header-only inbox, ticket window). The working tree as re-verified on 2026-08-25 shows those closures are materially present in code and covered by 129 tests across 33 suites (previously 66 unit-only, one certifying the C1 bug). Two transient test-environment defects (Google env leakage + redirect URI mismatch) were the only blockers until a small env/test isolation fix. No external benchmark was reproduced; performance numbers remain unverified.

## Findings by Question / Theme

### 1. What does DueKeeper claim to do vs what the codebase actually does?

**Claimed (README/AUDIT):** Full-stack deadline & reminder platform: canonical UTC `dueAt` + IANA `timezone`, live status `upcoming→due_soon→overdue` plus `done/cancelled` with snooze, heuristic + Gemini extraction (text/screenshot), per-user `deadline+<token>@domain` forwarding webhook (SendGrid-compatible) with auto-save, calendar ICS import/export + optional Google OAuth incremental sync, transactional outbox on SQLite (planner→deliveries→outbox with leases/backoff/watchdog), SSE with ticket, web-push VAPID+RFC 8291, two channels (in-app + SMTP), hardened auth (HS256 JWT, scrypt, revolving refresh with theft detection, rate limits).

**Observed:** All claims are implemented in the expected modules: `server/src/modules/events` CRUD + reminders + status compute, `server/src/modules/extract` Gemini + heuristic + `imageValidate` magic-byte check, `server/src/modules/inbox` header-only token + `To`-only resolution + timezone-aware extraction, `server/src/modules/calendar` ICS + Google (`syncToken`, keyword filter, `external_events` identity map), `server/src/engine` planner/outbox/scheduling + `server/src/lib` JWT/password/secretbox/push/zonedTime. The single most important original finding (web push never delivered readable payload, metrics said healthy) is now inverted: the key schedule is literal and the test suite would fail if it regressed. No claim of “zero external infra to boot” is violated — the server still boots with `DB_PATH` default and console email fallback in dev.

### 2. Where do docs agree or disagree with implementation?

**Agreement:** AUDIT §1 architecture (migrations array, WAL/FK/busy_timeout, CHECK/CASCADE/UNIQUE/partial indexes), §2 flows (register/login/refresh/logout/me, event CRUD, extraction confirm, reminder engine diagram, SSE 25s heartbeat, Google `calendar.readonly` + `access_type=offline`), `ARCHITECTURE.md` engine lifecycle (60s planner, 30s outbox, 60s watchdog, 72h due-soon, 7d horizon, SSE ticket, `MAX_LIST_PAGE_SIZE`), `API.md` error envelope + pagination + auth contracts, `DATABASE.md` WAL/FK/CHECK/CASCADE/uniqueness/partial indexes — all match code as re-read.

**Disagreement (local, now fixed):** `server/.env` shipped `GOOGLE_REDIRECT_URI=…/sync/callback` while code default is `…/google/callback` and the HTTP test expected the latter; `GOOGLE_CLIENT_ID/SECRET` present in `.env` made the “not configured →422” test see `200`. Both were environment-vs-doc/code mismatches, not product bugs, and were corrected (env to `…/google/callback`, test now clears `config.google*`).

**Doc-vs-code drift that is not a bug:** `README` perf numbers and `ARCHITECTURE` throughput claims are env-specific and not reproduced in this run; code contains the right hooks (`scripts/bench.mjs`, `metrics`, `/api/metrics` queue depth) but no CI bench artifact.

### 3. What defects were claimed, what was remediated, and what residual risks remain?

**Critical C1–C4:** All four are closed where §9 says. C1 key schedule now literal with published vector (swap and order negative tests); C2 claim predicate now includes `next_retry_at` with `COALESCE` ordering and separate `reclaims` column plus `outboxQueueDepth` visibility; C3 paired inserts wrapped in `inTransaction` with repair and re-keyed `UNIQUE(reminder_id,scheduled_for)` via migration `006`; C4 `revokeAllSessions` atomic (`token_version` + `refresh_tokens` in one txn) called from both password change and revoke-all handlers.

**High H1–H8:** H1 callback moved outside `requireAuth` and start became `POST → {url,expiresIn}` with `405 Allow:POST` on old GET; H2 `state` validated/consumed/bound before exchange; H3 `from` fallback deleted, token header-only with `constantTimeEqual` and recipient redaction; H4 `req.ip` via `trust proxy`, `maxKeys 10000`, IP-only cap + limiters on refresh/logout/password; H5 offset-required `dueAt` + IANA zone + two-pass DST helper (duplicate inline removed); H6 snooze `1m…30d` + `Date` range guard; H7 `status='processing'` guards on `markFailed`/`markDelivery`; H8 delete cancels pending work then deletes in txn.

**Medium/structural (13–17):** Watchdog now `lease_until < now` (was `2×` lease), `reclaims` not consuming `attempts`, `PLANNER_GRACE_SECONDS 60` aligns two producers, shutdown drains `outboxBusy` with deadline, `unhandledRejection`/`uncaughtException` counted; refresh reads+validates inside one `inTransaction`; tick coalesce via `engineTicksCoalesced` not drop; push upserts checked per-account cap and `ON CONFLICT … WHERE` ownership; outbox bounded concurrency (`OUTBOX_CONCURRENCY 5`) and `LIMIT`; `AbortController` timeouts on all outbound `fetch` + `nodemailer` socket timeouts; email `Message-ID`/`X-Entity-Ref-ID`; SSE ticket (30s single-use) + `Authorization` header re-checks revocation + backpressure close + per-user cap; prod `SMTP_HOST` required (throws, not silent console); `ENCRYPTION_KEY` required/charset+length + `!=JWT_SECRET` + `PREVIOUS_ENCRYPTION_KEYS` rotation (prod fail-fast, tries current+previous); DST via shared `zonedTime`, `isValidCivilDate` rejects `2026-02-31`, `civilDateInZone` for relative dates, ICS bare `\r` folding, `toIcsDateTime` UTC-normalized, done→reopen preserved, pagination in SQL with `page` envelope.

**Residuals accepted per AUDIT §9:** SQLite single-writer (Render single disk; horizontal needs Postgres; claim predicate already skip-locked-compatible); scrypt `N=16384` below OWASP 2^17 but self-describing and raise-able; web-push proven by RFC 8291 §5 vector not live browser (watch `pushesFailed`); inbox header-only not provider HMAC (replay bounded to duplicate events via content-derived receipt key); ticket carries no `token_version` (30s window, single-use, existence check); Gemini fenced+type-checked but still steerable (user-confirmed except inbox `≥0.7` auto-save product decision); no CSRF tokens (bearer-only, no cookies).

### 4. What defaults/configs/evidence types support each claim?

Defaults observed in `server/src/config/env.ts`: `JWT_EXPIRES_IN 15m`, `REFRESH_TOKEN_TTL 30d`, `LOGIN_RATE_LIMIT 10/15m`, `REGISTER 30/60m`, `OUTBOX_LEASE_SECONDS 120` (10–3600), `OUTBOX_CLAIM_LIMIT 50` (1–500), `OUTBOX_MAX_ATTEMPTS 3`, `OUTBOX_MAX_RECLAIMS 3`, `OUTBOX_CONCURRENCY 5`, `PLANNER_GRACE_SECONDS 60` (0–3600), `PLANNER_BATCH_LIMIT 500`, `OUTBOUND_FETCH_TIMEOUT 10s`, `SMTP_TIMEOUT 10s`, `SSE_MAX_CONNECTIONS_PER_USER 5`, `RATE_LIMIT_MAX_KEYS 10000`, `MAX_LIST_PAGE_SIZE 100` (10–1000). Production guard refuses boot on weak `JWT_SECRET`, missing/bad `ENCRYPTION_KEY`, `==JWT_SECRET`, bad `PREVIOUS_ENCRYPTION_KEYS`, non-HTTPS `APP_BASE_URL`, localhost `CORS`, or missing `SMTP_HOST` (unless `ALLOW_LOCALHOST_E2E=1`).

Evidence types: **code** (seam exists where §9 says), **HTTP integration** (`src/tests/http.test.ts` boots app on temp DB, covers every finding), **unit** (`src/tests/push.test.ts` RFC vector + swap/reversed/byte-for-byte/cross-check), **config guard** (prod refusal), **command** (`npm run typecheck` 0, `npm test` 129/33/0, `web npx tsc --noEmit` 0, `npm run smoke` 101 checks when run against live API).

### 5. What is unverified or uncertain?

- Performance: `~6.8k req/s health, ~2.6k req/s auth reads p99<30ms (c50)` from `README` not reproduced here (no `bench.mjs` run, no chart tool, no `web_search` in this harness).
- Live-browser push: vector settles crypto, not that a push service accepts headers; first real subscription should watch `pushesFailed`.
- Provider HMAC for inbox: header-only vs HMAC-over-body (next step).
- Ticket version window (30s) and inbox auto-save `≥0.7` (product decision).
- Scale: SQLite single-instance remains the deployment reality.

## Caveats and Disagreements

- No disagreement on defect reality; original C1 self-certifying round-trip and C2 dead backoff were accurately diagnosed and are now fixed as described.
- One disagreement between `.env` and doc/code (Google redirect/callback) was a local-env vs test expectation issue, not a product regression, and is now aligned.
- Quantitative perf claims are doc-only until reproduced in CI on recorded hardware.

## Open Questions

1. Should `PREVIOUS_ENCRYPTION_KEYS` rotation be drilled in CI by encrypting with an old key, rotating, and decrypting (proves `v1.` path)?
2. Should the 30s ticket carry `token_version` (narrow pre-revocation window to zero) or is single-use + existence check sufficient for this threat model?
3. When should `scrypt N` be raised from 16384 to 2^17 given single-instance CPU budget?
4. Is inbox provider HMAC priority higher than duplicate-event bounding already provided by content-derived `Message-ID`?
5. Can `scripts/bench.mjs` + `scripts/smoke.mjs` be run in CI to turn README perf claims into recorded artifacts?


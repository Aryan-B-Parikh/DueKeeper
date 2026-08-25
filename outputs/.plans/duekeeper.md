# Audit Plan — DueKeeper (slug: `duekeeper`)

> **See also:** `duekeeper-sources.md` (comparison matrix) · `duekeeper-deep-research.md` (cited deep research) · `outputs-improvement.md` (outputs cleanup) · Index: `outputs/README.md`

## Target
- **Slug:** `duekeeper` (lowercase, 1 word, ≤5)
- **Paper / Spec:** `D:/DueKeeper/AUDIT.md` (2026-08-24 audit, 6.8/10, C1–C4, H1–H8, §5 medium, §6 strengths, §8/§9 remediation) + supporting claims in `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`
- **Repo:** `D:/DueKeeper` — primary scope `server/` (53 TS files, ~7k LOC, Express 4, TypeScript strict, node:sqlite DatabaseSync, Zod, multer, nodemailer, Node ≥24, 5 runtime deps). Web and mobile out-of-scope except where audit touches API contract.
- **Artifact:** `outputs/duekeeper-audit.md` (exactly one file)

## Claims to Check (map directly to §3–§9 + README)

### Critical (C1–C4)
- C1 web-push RFC 8291 §3.3: key derivation order, `WebPush: info` IKM, CEK/nonce `Content-Encoding: aes128gcm\0` without draft-04 suffix, header framing/VAPID vs payload, metrics/logging swallowing, self-certifying `decryptPayload` test replaced by §5 vector.
- C2 outbox backoff dead code: `next_retry_at` read vs written, claim predicate, index `idx_outbox_claim`, burn rate (3×30s), dead-letter observability.
- C3 planner paired inserts: transactionality (`inTransaction`), `UNIQUE (reminder_id)` vs `UNIQUE (reminder_id, scheduled_for)`, idempotency on reschedule/reopen, orphan repair.
- C4 `token_version` vs `refresh_tokens` revocation: `revokeAllForUser`/`revokeAllSessions` atomicity, handlers at `users.routes` 126/138, `rotateRefreshToken` checking `token_version`.

### High (H1–H8)
- H1 Google OAuth routability: `requireAuth()` on `/google/callback` & `/google/start` 302 vs browser navigation + `Authorization` header.
- H2 token exchange before `state` validation: oracle with `client_secret`, `used` replay window, `stateRow.user_id` binding.
- H3 inbox `from` fallback + token-in-URL logging + logger redaction.
- H4 `X-Forwarded-For` vs `req.ip`+`trust proxy`, `sweep`/`maxKeys` unbounded growth, IP-only vs per-email caps, missing `/refresh|/logout|/password` limiters, scrypt amplifier.
- H5 naive datetime server-tz parse vs IANA `timezone` column.
- H6 snooze unbounded `RangeError`.
- H7 `markFailed`/`markDelivery` missing `status='processing'` guard / lease race.
- H8 delete without `cancelPendingWork` vs update/done/cancel/snooze.

### Medium (§5) & §6 strengths & §7 ratings
- Reliability: watchdog `2× lease`, `attempts` vs `reclaims`, grace window mismatch, shutdown drain, unhandledRejection.
- Concurrency: refresh outside txn, tick boolean drop vs defer/coalesce.
- Cross-user: push upsert `ON CONFLICT` ownership, delete scoping.
- Blocking I/O: `DatabaseSync` sync, planner no LIMIT, outbox serial 50×SMTP vs lease, AbortSignal/socketTimeout, email idempotency.
- SSE: query JWT vs ticket, `res.write` backpressure, per-user cap.
- Production: console fallback for `SMTP_HOST` in prod, `secretbox` key derivation (`JWT_SECRET` fallback, no rotation, `v1.` prefix), `google.ts` decrypt swallowing.
- Correctness: DST offset sampling duplication, heuristic date validation, relative dates server zone, ICS `\r` escaping/`toIcsDateTime`, done→reopen, list `LIMIT 500` post-filter.
- Prompt injection: raw interpolation of `text`/`timezone` into Gemini, missing model-output type checks.
- §6 claims: JWT algs, scrypt NFKC+timingSafeEqual, AES-GCM, refresh theft detection, SQL parameterization, security headers, config prod guard, OAuth scope, magic-byte image check.
- README/ARCHITECTURE metrics: `~6.8k req/s`, `p99 <30ms`, reminder semantics, extraction pipeline defaults (Gemini model, heuristic fallback, rate limits 10/hour, image 10MB, `MAX_INPUT_CHARS`).

### §8/§9 Remediation verification (2026-08-25 re-verify)
- For each C/H/§8 step: file + mechanism + test that fails if reverted. Check `server/.env` / test isolation leakage that caused 2 suite failures after audit merge.

## Method

1. **Evidence gathering (researcher role):** grep/read source for each claim line (`rg`/`read` with line refs), dump config defaults from `config/env.ts` + actual `server/.env`, enumerate tests in `src/tests/*.ts` vs claims, sample runtime behavior (`npm run typecheck`, `npm test` before/after fixes).
2. **Verification (verifier role):** add inline citations (`path:line`) for every claim–code pairing; where paper cites line numbers, re-resolve against current HEAD (many have shifted post-remediation). Flag ambiguous defaults (e.g., `OUTBOX_LEASE_SECONDS` 120, `PLANNER_GRACE_SECONDS`, `MAX_LIST_PAGE_SIZE`) and reproduction risks (single-instance SQLite, `N=16384` scrypt, live-browser push vector gap).
3. **Comparison:** table per-finding: claimed defect → actual code → match/mismatch/partial → reproduction risk.
4. **Output:** single Markdown `outputs/duekeeper-audit.md` with Executive Summary, Scope/Method, Claim-by-Claim Verification (C/H/Medium/Strengths/Metrics), Missing/Ambiguous/Reproduction Risks, Overall Verdict (score delta since 6.8), `Sources` URLs.

## Repo Pointers
- Entry: `server/src/index.ts`, `server/src/app.ts`
- DB: `server/src/db/database.ts`, `server/src/db/schema.ts`, `server/src/db/migrate.ts`
- Crypto/push: `server/src/lib/push/webpush.ts`, `server/src/lib/push/vapid.ts`, `server/src/lib/jwt.ts`, `server/src/lib/password.ts`, `server/src/lib/secretbox.ts`
- Engine: `server/src/engine/outbox.ts`, `server/src/engine/planner.ts`, `server/src/engine/scheduling.ts`, `server/src/engine/channels/*`
- Routes: `server/src/modules/{auth,events,extract,calendar,inbox,notifications,users}/*`
- Tests: `server/src/tests/{push,http,*.test}.ts`, `server/scripts/smoke.mjs`

## Risks & Limits
- No formal paper (audit is the spec) → treat `AUDIT.md` as source of truth.
- Post-remediation code has moved line numbers; verification must re-search not rely on stale `AUDIT.md:line` refs.
- Tool discipline: only `default.*` tools + `write`; use `feynman alpha ...`/`web_search`/`fetch_content`/`alpha_search` nomenclature if external fetch needed; synthesize researcher/verifier via direct reads when subagent tool not exposed.

## Schedule
- Plan write → immediate summary → evidence sweep → verifier pass → single artifact write; no confirmation gate.

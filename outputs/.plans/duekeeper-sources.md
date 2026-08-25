# Comparison Plan — duekeeper-sources

> **See also:** `duekeeper.md` (audit) · `duekeeper-deep-research.md` (cited) · `outputs-improvement.md` · Index: `outputs/README.md`

Slug: `duekeeper-sources` (derived from fallback topic — original prompt "Compare sources for:" was empty; using DueKeeper audit source set as implied comparison target, ≤5 words, lowercase hyphens)

## Sources to Compare
1. **AUDIT.md** (2026-08-24 original audit, §9 2026-08-25 remediation table) — canonical defect claims + remediation promises
2. **README.md** — user-facing capability/performance claims (reminders, extraction, auth, perf)
3. **docs/ARCHITECTURE.md** — system design, engine lifecycle, security model
4. **docs/API.md** — contract/error envelope/pagination/rate-limit claims
5. **docs/DATABASE.md** — schema/migration claims (when present)
6. **server/ implementation** (`server/src/*`, `server/src/config/env.ts`, `server/src/db/schema.ts`, `server/src/engine/*`, `server/src/lib/*`) — ground truth
7. **server/src/tests/** + `server/scripts/smoke.mjs` — evidence of coverage

## Dimensions to Evaluate
- **Auth & session** (JWT `iss/aud/exp`, `token_version`, refresh rotation/theft, rate limits)
- **Reliability / job engine** (outbox claim predicate, backoff, lease watchdog, planner grace, shutdown drain)
- **Data & transactions** (SQLite WAL/FK/busy_timeout, `inTransaction` usage, UNIQUE constraints, pagination in SQL)
- **Cryptography** (scrypt params, AES-GCM, web-push RFC 8291 key schedule + VAPID)
- **Validation & correctness** (datetime IANA/offset, DST two-pass, snooze bounds, ICS, prompt injection)
- **Operability** (SSE ticket vs JWT in URL, SMTP prod guard, key rotation `v1.`/`PREVIOUS_ENCRYPTION_KEYS`, metrics/backpressure)
- **Testing / docs fidelity** (unit vs HTTP integration, RFC vector vs round-trip)

## Expected Output Structure (outputs/duekeeper-sources-comparison.md)
- Title + slug + date + one-line topic framing (notes empty prompt fallback)
- Method note (researcher/verifier roles simulated — tool not exposed)
- Comparison matrix: columns `Source | Key Claim | Evidence Type | Caveats | Confidence` with inline citations (`path:line` or `AUDIT.md §`)
- Agreement / Disagreement / Uncertainty sections (short, source-backed)
- Mermaid architecture sketch (source-supported, if structure consistent)
- Chart spec vs table decision (no quantitative bench run → table/spec, not chart)
- Sources section with direct URLs / file paths for every source used

## Tooling Notes
- `researcher`/`verifier` subagents not visible in current tool set (`default.read/bash/edit/write` only) — will simulate via direct `read`/`bash` grep and inline `path:line` citations.
- `web_search`/`fetch_content`/`alpha_search` not visible — web fetch recorded as blocked; comparison stays local-file-backed.
- No chart tool visible → use source-backed table / Mermaid / chart specification.

## Execution Steps
1. Re-read AUDIT.md §3-§9, README, ARCHITECTURE, API, env defaults, key code seams
2. Build matrix row by row with evidence type (unit test, HTTP test, code, config guard, doc)
3. Mark agreement/disagreement/uncertainty
4. Write single comparison artifact to `outputs/duekeeper-sources-comparison.md`
5. Brief summary to user (no confirmation gate)

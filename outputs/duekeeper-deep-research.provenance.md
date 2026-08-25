# Provenance: duekeeper-deep-research

- **Date:** 2026-08-25
- **Rounds:** 1 research round (direct, 3 query angles)
- **Sources consulted:** 22 (AUDIT.md, README.md, docs/ARCHITECTURE.md, docs/API.md, docs/DATABASE.md, docs/SETUP.md, server/src/config/env.ts, server/src/db/database.ts, server/src/db/schema.ts, server/src/engine/outbox.ts, server/src/engine/planner.ts, server/src/engine/scheduling.ts, server/src/lib/time.ts, server/src/lib/password.ts, server/src/lib/push/webpush.ts, server/src/lib/secretbox.ts, server/src/lib/zonedTime.ts, server/src/lib/datetimeValidation.ts, server/src/modules/calendar/calendar.routes.ts, server/src/modules/inbox/inbox.routes.ts, server/src/tests/push.test.ts, server/src/tests/http.test.ts + bash typecheck/test)
- **Sources accepted:** 22 (all local-file-backed; no external fetch)
- **Sources rejected:** 4 external specs paper-cited but not fetched (RFC 8291 §3.3/§5, RFC 8188, RFC 8292 §2, OWASP scrypt N≥2^17 — cited in AUDIT.md, verified only via push.test.ts vector; `web_search`/`fetch_content` not exposed in `default.*` tool set) + 0 dead/unverifiable local paths
- **Verification:** PASS (no FATAL; 1 MAJOR noted as Open Question, 2 MINOR already handled — see `outputs/.drafts/duekeeper-deep-research-verification.md`)
- **Plan:** outputs/.plans/duekeeper-deep-research.md
- **Research files:** outputs/.drafts/duekeeper-deep-research-research-direct.md (3 queries: definition/history, mechanism/formula, current usage/comparison + `npm test 129/129`)

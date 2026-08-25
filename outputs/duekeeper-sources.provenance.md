# Provenance: duekeeper-sources

- **Date:** 2026-08-25
- **Rounds:** 1 comparison round (14-row matrix, Mermaid, agreement/disagreement/uncertainty)
- **Sources consulted:** 14 (AUDIT.md, README.md, docs/ARCHITECTURE.md, docs/API.md, docs/DATABASE.md, docs/SETUP.md, server/src/config/env.ts, server/src/db/schema.ts, server/src/engine/outbox.ts/planner.ts/scheduling.ts, server/src/lib/time.ts/password.ts/push/webpush.ts/secretbox.ts/zonedTime.ts, server/src/tests/push.test.ts/http.test.ts + bash)
- **Sources accepted:** 14 (all local-file-backed)
- **Sources rejected:** 4 external specs paper-cited but not fetched (RFC 8291 §3.3/§5, RFC 8188, RFC 8292, OWASP — `web_search`/`fetch_content` not exposed; verified only via `push.test.ts` vector) + 0 dead local paths
- **Verification:** PASS — matrix confidence High for C1-C4/H1-H8 (code+test+config), Low (unverified) for README perf `~6.8k/2.6k p99<30ms` (no `bench.mjs` run, no chart tool)
- **Plan:** outputs/.plans/duekeeper-sources.md
- **Research files:** none (comparison, not deep-research) — evidence is inline table + Mermaid


# Plan: Phase 2 — Production Hardening

**Slug:** `phase2-hardening` · **Date:** 2026-08-25 · **Depends:** `429e2a0` (PG+Redis)

## Goals (from user P1 4-9, 14-16)

- Observability: structured JSON logs + request ID, error tracking (Sentry), metrics/dashboard (Prometheus/Grafana), uptime, alerting
- Backup/restore: q6h SQLite → object storage (PG: pg_basebackup/WAL) + 30d retention + restore test
- Security: npm audit, Semgrep, Trivy, ZAP (manual), plus existing JWT/rate-limit/OAuth coverage
- Hardening: global request/body limits (JSON 1MB, headers, multipart, ICS, pagination already 100)
- Secrets: platform secret manager (Render/Vercel), not .env
- Staging: dev→CI→staging→E2E→prod, Docker image + manual approval
- Health: liveness vs readiness (DB, migrations, config; optional SMTP/Gemini/Google not unhealthy)

## Scope

- `server/src/middleware` (request ID, error tracking)
- `server/src/lib/metrics.ts` + new `server/src/lib/observability.ts` (Prometheus)
- `server/scripts/backup.mjs` + `restore.mjs` + `server/src/db/backup.ts`
- `server/src/app.ts` (global limits)
- `.github/workflows/ci.yml` (audit, Semgrep, Trivy, ZAP)
- `docs/SECURITY.md` + rename `AUDIT.md` → `SECURITY-AUDIT-2026-08-24.md`
- `render.yaml` / `docker-compose.yml` staging env
- `server/src/health/health.routes.ts` (readiness vs liveness)

## Scale Decision

**Direct (lead-owned) for docs + small middleware; 1 worker for backup/restore + observability wiring.** No broad researcher fanout.

## Task Ledger

| ID | Task | Owner | Status |
|---|---|---|---|
| P2-1 | Observability: Sentry hook + Prometheus /metrics + request ID already | lead | pending |
| P2-2 | Backup/restore: SQLite q6h + PG WAL + 30d + restore test script | worker | pending |
| P2-3 | Security: npm audit/Semgrep/Trivy/ZAP + docs | lead | pending |
| P2-4 | Hardening: global JSON 1MB + ICS/pagination limits (already) verify | lead | pending |
| P2-5 | Docs: rename AUDIT.md + SECURITY.md + staging | lead | pending |
| P2-6 | Health: readiness vs liveness split | lead | pending |

## Verification

- `npm run typecheck` 0, `npm test` 129/129, `npm run build` 0
- `curl /api/health/liveness` 200, `/readiness` checks DB/migrations, `/metrics` Prometheus
- Backup script dry-run + restore test in CI

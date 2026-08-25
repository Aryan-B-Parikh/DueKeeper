# Plan: SaaS — PG + Redis (full)

**Slug:** `saas-pg-redis` · **Date:** 2026-08-25 · **Mode:** Broad (3–4 researcher subagents) → worker

## Key Questions
1. How to make DueKeeper horizontally scalable without rewriting `routes→services→db` and `planner→outbox→channels`?
2. What is the minimal PG + Redis slice that proves `SKIP LOCKED` + delayed jobs + N API instances?
3. What are the cutover risks (data migration, secrets, backups, observability)?

## Evidence Needed
- `server/src/db/*` (SQLite WAL, `inTransaction` SAVEPOINT, `prepare`/`queryAll`)
- `server/src/engine/outbox.ts` claim (`BEGIN IMMEDIATE` → `FOR UPDATE SKIP LOCKED`)
- `server/src/config/env.ts` (DATABASE_URL, REDIS_URL, prod guards)
- `docker-compose.yml`, `render.yaml`, `server/Dockerfile`
- `server/src/lib/metrics.ts`, `server/src/engine/planner.ts` (ticks)
- Benchmarks: `scripts/bench.mjs` before/after

## Scale Decision
**Broad — 3 researcher subagents** (PG, Redis/queue, infra/secrets) then 1 worker. Direct search insufficient for 4-domain migration.

## Task Ledger
| ID | Task | Owner | Status |
|---|---|---|---|
| R1 | PG research: pg driver, `SKIP LOCKED`, `TIMESTAMPTZ`, migration diff | researcher | pending |
| R2 | Redis/BullMQ research: delayed jobs, rate-limit, pub/sub vs PG advisory | researcher | pending |
| R3 | Infra research: compose, Render, secrets, backups, observability | researcher | pending |
| W1 | Worker: DB abstraction `db/client.ts` + PG `SKIP LOCKED` claim + Redis optional | worker | pending |
| V1 | Verifier: citations + `typecheck`/`test` | verifier | pending |
| R4 | Reviewer: correctness/tests/simplicity | reviewer | pending |

## Verification Log
| Check | Status |
|---|---|
| Plan artifact | done (this file) |
| DB abstraction keeps SQLite for dev | pending |
| `SKIP LOCKED` claim works with N workers | pending |
| `npm run typecheck` 0 | pending |
| `npm test` 129/129 | pending |

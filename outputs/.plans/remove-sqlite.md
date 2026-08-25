# Plan: Remove SQLite, PG+Redis Only

**Slug:** `remove-sqlite` · **Date:** 2026-08-25 · **Goal:** SQLite → PG+Redis 100%, no fallback

## Scope

- Remove `node:sqlite` / `DatabaseSync` / `DB_PATH` / `db/database.ts` SQLite path
- Make all DB calls async (PG Pool is async)
- Update `db/migrate.ts`, `db/schema.ts` for PG types (TEXT→TEXT, but handle PRAGMA, VACUUM, etc.)
- Update every `prepare`/`queryAll`/`inTransaction` call site to be async (events, auth, inbox, notifications, calendar, engine, tests)
- Update `server/.env.example`, `docker-compose.yml`, `render.yaml` to PG-only
- Update tests to use PG (docker `db:5432` or `DATABASE_URL` test)
- Remove SQLite volume `duekeeper-data` / `pg-data` rename

## Evidence

- `server/src/db/database.ts` — currently hybrid SQLite/PG
- `server/src/db/migrate.ts` — already has PG branch, need to remove SQLite branch
- `server/src/engine/outbox.ts` — already has PG SKIP LOCKED branch, need to remove SQLite branch and make fully async
- `server/package.json` — `pg`, `ioredis`, `bullmq` already added, need to remove `node:sqlite` (built-in, no dep)
- `docker-compose.yml` — already has pg+redis, need to remove SQLite volume/api DB_PATH
- `render.yaml` — already has pserv PG, need to remove disk

## Tasks

| ID | Task | Owner | Status |
|---|---|---|---|
| S1 | Make `db/client.ts` PG-only, remove SQLite `DatabaseSync`, make `queryAll`/`inTransaction` async | worker | pending |
| S2 | Update all services/routes to async/await (events, auth, etc.) | worker | pending |
| S3 | Update `migrate.ts` to PG-only, remove PRAGMA, handle `schema_migrations` | worker | pending |
| S4 | Update `docker-compose`/`render` to PG-only, remove SQLite disk/volume | worker | pending |
| S5 | Update tests to PG (docker) and verify 129/129 | worker | pending |
| S6 | Remove `DB_PATH` from config, require `DATABASE_URL` in prod | worker | pending |

## Verification

- `npm run typecheck` 0
- `npm test` 129/129 on PG
- `docker compose up pg+redis` + `smoke 101` on PG
- No `node:sqlite` import remains (`grep -r "node:sqlite" server/src` 0)

## Risk

- Large refactor (every DB call site becomes async) — do in one worker slice with narrow deadline, keep SQLite branch as backup until final cutover (feature flag `USE_PG` → then remove flag)

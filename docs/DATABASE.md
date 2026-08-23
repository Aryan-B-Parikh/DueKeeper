# Database

Embedded SQLite via `node:sqlite` (WAL mode, foreign keys ON, 5s busy timeout), migrated by `server/src/db/migrate.ts` with recorded, transactional migrations in `schema.ts`. File location: `DB_PATH` (default `server/data/duekeeper.db`).

All timestamps are **ISO-8601 UTC text** — lexicographic comparison equals chronological comparison.

## Tables

### users
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| email | TEXT UNIQUE | lowercased |
| password_hash | TEXT | `scrypt$N$r$p$salt$key` |
| display_name | TEXT | |
| timezone | TEXT | IANA, default `UTC` |
| notification_prefs | TEXT | JSON object |
| forwarding_token | TEXT UNIQUE | 16-byte hex for inbox address |
| created_at / updated_at | TEXT | |

### events
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT FK→users CASCADE | indexed with due_at |
| title / description | TEXT | description nullable |
| event_type | TEXT CHECK | exam/submission/hackathon/other |
| due_at | TEXT | canonical UTC instant |
| timezone | TEXT | display timezone |
| source | TEXT CHECK | manual/ai_text/ai_screenshot/email/calendar/ics_import |
| ai_confidence | REAL NULL | from extraction |
| confirmation_status | TEXT NULL | auto_saved/user_confirmed |
| status | TEXT CHECK | upcoming/due_soon/overdue/done/cancelled |
| done_at | TEXT NULL | |

Indexes: `(user_id, due_at)`, `(status, due_at)`.

### reminders
`id`, `event_id FK→events CASCADE`, `offset_seconds INTEGER [0..604800]`, `channel email|in_app`, `enabled 0|1`, `created_at`.
Unique `(event_id, offset_seconds, channel)` makes planning idempotent.

### reminder_deliveries
Business state per planned fire: `id`, `reminder_id UNIQUE FK→reminders CASCADE`, `event_id`, `user_id`, `scheduled_for`, `status pending/sent/failed/cancelled`, `sent_at`.

### notification_outbox
The queue: `id`, `delivery_id UNIQUE FK→reminder_deliveries CASCADE`, `payload JSON`, `status pending/processing/sent/failed/cancelled`, `attempts`, `max_attempts (3)`, `scheduled_at`, `next_retry_at`, `processing_started_at`, `lease_until`, `last_error`, `sent_at`, `idempotency_key UNIQUE` (`reminder:<deliveryId>`).
Claim index `(status, scheduled_at, next_retry_at)`; partial lease-watchdog index on `processing`.

### notifications
In-app inbox rows: `id`, `user_id FK`, `event_id FK SET NULL`, `type reminder/system/info/warning`, `title`, `body`, `read 0|1`, `idempotency_key UNIQUE` (dedupes outbox retries).

### calendar_connections
One row per user/provider: encrypted access & refresh tokens (AES-256-GCM via `lib/secretbox`), `token_expires_at`, incremental `sync_token`, `calendar_id`, `last_synced_at`, `connected_at`.

### external_events
Provider identity map: unique `(user_id, provider, external_id)` → `event_id`. Providers: `ics` (UIDs), `google` (event ids). Guarantees re-import/re-sync never duplicates.

### oauth_states
Single-use OAuth CSRF state: `state PK`, `user_id FK`, `expires_at` (10 min), `used 0|1`, consumed atomically in the callback.

### schema_migrations
Applied migration ledger (`id`, `applied_at`) — the runner applies pending migrations in order inside transactions. **Published migrations are immutable; corrections are new forward migrations.**

## Rules

1. Never reintroduce legacy date columns — `due_at` + `timezone` is canonical.
2. Ownership is always enforced in SQL (`WHERE user_id = ?`); FK cascades clean up children.
3. Status enums are enforced by CHECK constraints; add values only via a new migration.
4. Outbox state transitions must stay guarded by lease conditions so stale workers can't clobber reclaimed jobs.

export interface Migration {
  id: string;
  sql: string;
  /**
   * Set for migrations that rebuild a table other tables reference. SQLite
   * cannot drop a column-level UNIQUE constraint in place, so the table must be
   * recreated — and `PRAGMA foreign_keys` can only be changed outside a
   * transaction, so the runner has to handle it rather than the SQL.
   */
  rebuildsReferencedTable?: boolean;
}

export const migrations: Migration[] = [
  {
    id: '001_initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  notification_prefs TEXT NOT NULL DEFAULT '{"reminderEmails":true,"dueSoonAlerts":true}',
  forwarding_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT NOT NULL DEFAULT 'other' CHECK (event_type IN ('exam','submission','hackathon','other')),
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_text','ai_screenshot','email','calendar','ics_import')),
  ai_confidence REAL,
  confirmation_status TEXT CHECK (confirmation_status IN ('auto_saved','user_confirmed')),
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','due_soon','overdue','done','cancelled')),
  done_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user_due ON events(user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_events_status_due ON events(status, due_at);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  offset_seconds INTEGER NOT NULL CHECK (offset_seconds >= 0 AND offset_seconds <= 604800),
  channel TEXT NOT NULL CHECK (channel IN ('email','in_app')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (event_id, offset_seconds, channel)
);
CREATE INDEX IF NOT EXISTS idx_reminders_event ON reminders(event_id);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL UNIQUE REFERENCES reminders(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_window ON reminder_deliveries(status, scheduled_for);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES reminder_deliveries(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL,
  next_retry_at TEXT,
  processing_started_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  sent_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON notification_outbox(status, scheduled_at, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_outbox_lease ON notification_outbox(status, lease_until) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'reminder' CHECK (type IN ('reminder','system','info','warning')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read, created_at);

CREATE TABLE IF NOT EXISTS calendar_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  sync_token TEXT,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  last_synced_at TEXT,
  connected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL,
  UNIQUE (user_id, provider, external_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
`
  },
  {
    id: '002_performance_indexes',
    sql: `
CREATE INDEX IF NOT EXISTS idx_deliveries_user_pending ON reminder_deliveries(user_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminders_enabled_event ON reminders(enabled, event_id);
`
  },
  {
    id: '003_sessions_and_push',
    sql: `
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
`
  },
  {
    id: '004_refresh_tokens',
    sql: `
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at);
`
  },
  {
    id: '005_expo_push_tokens',
    sql: `
CREATE TABLE IF NOT EXISTS expo_push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expo_tokens_user ON expo_push_tokens(user_id);
`
  },
  {
    id: '006_delivery_rescheduling_and_reclaims',
    rebuildsReferencedTable: true,
    sql: `
-- reminder_deliveries.reminder_id was UNIQUE, which capped every reminder at
-- exactly one delivery for all time. Cancelling a delivery (snooze, edit,
-- reopen) therefore permanently silenced that reminder: the replanning INSERT
-- OR IGNORE always collided with the cancelled row and was skipped. Key the
-- uniqueness on the fire time instead, so rescheduling materializes a new row
-- while still de-duplicating repeated planner ticks.
CREATE TABLE reminder_deliveries_rebuild (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (reminder_id, scheduled_for)
);

INSERT INTO reminder_deliveries_rebuild
  (id, reminder_id, event_id, user_id, scheduled_for, status, sent_at, created_at)
SELECT id, reminder_id, event_id, user_id, scheduled_for, status, sent_at, created_at
FROM reminder_deliveries;

DROP TABLE reminder_deliveries;
ALTER TABLE reminder_deliveries_rebuild RENAME TO reminder_deliveries;

CREATE INDEX IF NOT EXISTS idx_deliveries_window ON reminder_deliveries(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_deliveries_user_pending ON reminder_deliveries(user_id, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON reminder_deliveries(event_id, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_reminder ON reminder_deliveries(reminder_id, status);

-- A lease that expires because the worker died is not a failed delivery
-- attempt, so reclaiming refunds the attempt. Counting reclaims separately
-- keeps that refund from turning a crash-looping job into an infinite retry.
ALTER TABLE notification_outbox ADD COLUMN reclaims INTEGER NOT NULL DEFAULT 0;

-- Claim ordering is COALESCE(next_retry_at, scheduled_at); this index matches it.
CREATE INDEX IF NOT EXISTS idx_outbox_ready
  ON notification_outbox(status, next_retry_at, scheduled_at);
`
  }
];

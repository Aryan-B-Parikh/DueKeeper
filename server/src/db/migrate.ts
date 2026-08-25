import { getDb } from './database';
import { migrations, type Migration } from './schema';
import { createLogger } from '../lib/logger';

const log = createLogger('db');

function applyMigration(db: ReturnType<typeof getDb>, migration: Migration): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
      migration.id,
      new Date().toISOString()
    );
    if (migration.rebuildsReferencedTable) {
      // Foreign keys are off for this migration, so nothing validated the
      // copied rows. Verify before committing rather than discovering a
      // dangling delivery_id at delivery time.
      const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Migration ${migration.id} left ${violations.length} foreign key violation(s); rolled back`
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
}

export function runMigrations(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((r) => r.id)
  );
  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    // PRAGMA foreign_keys is a no-op inside a transaction, so it has to be
    // toggled out here. Without this, DROP TABLE on a referenced table either
    // fails or cascades away the rows we just copied.
    if (migration.rebuildsReferencedTable) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        applyMigration(db, migration);
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    } else {
      applyMigration(db, migration);
    }

    log.info(`Applied migration ${migration.id}`);
    count += 1;
  }
  if (count === 0) log.info('Schema is up to date');
}

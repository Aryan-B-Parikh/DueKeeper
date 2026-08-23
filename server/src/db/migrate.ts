import { getDb } from './database';
import { migrations } from './schema';
import { createLogger } from '../lib/logger';

const log = createLogger('db');

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
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      );
      db.exec('COMMIT');
      log.info(`Applied migration ${migration.id}`);
      count += 1;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }
  }
  if (count === 0) log.info('Schema is up to date');
}

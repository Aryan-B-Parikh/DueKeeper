import { getDb } from './database';
import { isPgEnabled, getPgPool } from './pg';
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

export async function runMigrations(): Promise<void> {
  if (isPgEnabled()) {
    const pool = getPgPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r: { id: string }) => r.id));
    let count = 0;
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      // PG does not need PRAGMA foreign_keys dance — DDL is transactional and FKs are deferred per statement
      await pool.query('BEGIN');
      try {
        await pool.query(migration.sql);
        await pool.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [migration.id, new Date().toISOString()]);
        await pool.query('COMMIT');
      } catch (err) {
        try { await pool.query('ROLLBACK'); } catch {}
        throw err;
      }
      log.info(`Applied migration ${migration.id} (PG)`);
      count += 1;
    }
    if (count === 0) log.info('Schema is up to date (PG)');
    return;
  }
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((r: { id: string }) => r.id)
  );
  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
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

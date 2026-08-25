import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../config/env';

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const path = resolve(config.dbPath);
  mkdirSync(dirname(path), { recursive: true });
  instance = new DatabaseSync(path);
  instance.exec('PRAGMA journal_mode = WAL;');
  instance.exec('PRAGMA foreign_keys = ON;');
  instance.exec('PRAGMA busy_timeout = 5000;');
  return instance;
}

export function prepare(sql: string): StatementSync {
  return getDb().prepare(sql);
}

export function exec(sql: string): void {
  getDb().exec(sql);
}

/** Typed helper — removes the `as unknown as T[]` ceremony at call sites. */
export function queryAll<T>(sql: string, ...params: unknown[]): T[] {
  // DatabaseSync's StatementSync is typed as unknown[] → widen to any for ergonomics
  return (prepare(sql).all as (...p: unknown[]) => unknown[])(...params) as T[];
}

export function queryOne<T>(sql: string, ...params: unknown[]): T | undefined {
  return (prepare(sql).get as (...p: unknown[]) => unknown)(...params) as T | undefined;
}

let txDepth = 0;
let savepointSeq = 0;

/**
 * Runs `fn` inside a write transaction. Re-entrant: nesting uses SAVEPOINTs, so
 * a transactional helper can safely call another one. SQLite rejects a plain
 * `BEGIN` inside an open transaction, and without this a composed helper would
 * throw "cannot start a transaction within a transaction" — which callers then
 * tend to "fix" by dropping the transaction entirely.
 *
 * `fn` must be synchronous. `node:sqlite` is synchronous and a transaction is
 * connection-wide, so awaiting inside one would let unrelated work join it.
 */
export function inTransaction<T>(fn: () => T): T {
  const db = getDb();

  if (txDepth > 0) {
    savepointSeq += 1;
    const name = `sp_${savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    txDepth += 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* rollback after failure is best-effort */
      }
      throw err;
    } finally {
      txDepth -= 1;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback after failure is best-effort */
    }
    throw err;
  } finally {
    txDepth = 0;
  }
}

export function inTransactionDepth(): number {
  return txDepth;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
  txDepth = 0;
  savepointSeq = 0;
}

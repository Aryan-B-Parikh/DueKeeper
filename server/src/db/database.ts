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

export function inTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
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
  }
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

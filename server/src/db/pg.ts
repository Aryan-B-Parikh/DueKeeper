import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';

const log = createLogger('pg');

let pool: Pool | null = null;

export function isPgEnabled(): boolean {
  return Boolean(config.databaseUrl && config.databaseUrl.trim() !== '');
}

export function getPgPool(): Pool {
  if (!isPgEnabled()) throw new Error('DATABASE_URL not set — PG disabled');
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.databaseUrl,
    // Keep small for single-instance dev, scale via env in prod
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on('error', (err: Error) => log.error('PG pool error', err));
  log.info(`PG pool created (max=${Number(process.env.PG_POOL_MAX ?? 10)})`);
  return pool;
}

export async function pgQuery<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pgSql = toPgPlaceholders(sql);
  const result: QueryResult<T> = await getPgPool().query(pgSql, params as unknown[]);
  return result.rows;
}

export async function pgQueryOne<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await pgQuery<T>(sql, params);
  return rows[0];
}

export async function pgExec(sql: string, params: unknown[] = []): Promise<void> {
  const pgSql = toPgPlaceholders(sql);
  await getPgPool().query(pgSql, params as unknown[]);
}

export async function pgTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Converts SQLite `?` placeholders to Postgres `$1,$2` — our codebase uses `?` everywhere.
 * Handles `?` inside single-quoted strings as literal (not placeholder).
 */
function toPgPlaceholders(sql: string): string {
  let idx = 0;
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) {
      // handle escaped '' inside string
      if (sql[i + 1] === "'") { out += "''"; i++; continue; }
      inSingle = !inSingle; out += ch; continue;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; out += ch; continue; }
    if (ch === '?' && !inSingle && !inDouble) {
      idx++; out += `$${idx}`; continue;
    }
    out += ch;
  }
  return out;
}

export function closePgPool(): void {
  if (pool) {
    const p = pool; pool = null;
    void p.end().catch(() => {});
  }
}

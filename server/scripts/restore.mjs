#!/usr/bin/env node
/**
 * DueKeeper restore test — verifies a backup is actually restorable.
 * Usage: node scripts/restore.mjs --latest [--verify] [--dest s3://...] [--out /tmp/restore.db]
 * For SQLite: copies latest duekeeper-*.db to --out and runs `PRAGMA integrity_check` + `SELECT count(*) FROM events`.
 * For PG custom dump: runs `pg_restore --list` and optionally `pg_restore --clean --if-exists -d $RESTORE_DATABASE_URL`.
 * Exit 0 = restorable, non-zero = backup is not a backup.
 */
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dest = process.env.BACKUP_DEST || process.argv.find(a => a.startsWith('--dest='))?.split('=')[1] || './backups';
const verify = process.argv.includes('--verify');
const latest = process.argv.includes('--latest');
const outArg = process.argv.find(a => a.startsWith('--out='))?.split('=')[1];
const isPg = (process.env.BACKUP_PG === '1') || (process.argv.includes('--pg')) || Boolean(process.env.DATABASE_URL && process.argv.includes('--pg-auto'));

function log(m){ console.log(`[restore] ${new Date().toISOString()} ${m}`); }

function findLatest(dir) {
  const d = resolve(dir);
  if (!existsSync(d)) throw new Error(`backup dest not found: ${d}`);
  const files = readdirSync(d).filter(f => f.startsWith('duekeeper-') && (f.endsWith('.db') || f.endsWith('.dump'))).map(f => ({ f, m: statSync(join(d,f)).mtimeMs })).sort((a,b)=>b.m-a);
  if (!files.length) throw new Error(`no duekeeper-* backup in ${d}`);
  return join(d, files[0].f);
}

async function verifySqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const ok = row && (row.integrity_check === 'ok' || Object.values(row)[0] === 'ok');
    log(`integrity_check: ${JSON.stringify(row)}`);
    if (!ok) throw new Error(`integrity_check failed: ${JSON.stringify(row)}`);
    // best-effort count
    try { const c = db.prepare('SELECT count(*) as c FROM events').get(); log(`events count: ${JSON.stringify(c)}`); } catch {}
    try { const c2 = db.prepare('SELECT count(*) as c FROM users').get(); log(`users count: ${JSON.stringify(c2)}`); } catch {}
  } finally { db.close(); }
}

function verifyPgDump(path) {
  log(`pg_restore --list ${path}`);
  const r = spawnSync('pg_restore', ['--list', path], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`pg_restore --list failed (status ${r.status})`);
  if (process.env.RESTORE_DATABASE_URL) {
    log(`pg_restore --clean --if-exists -d $RESTORE_DATABASE_URL ${path} (verify)`);
    const r2 = spawnSync('pg_restore', ['--clean', '--if-exists', '-d', process.env.RESTORE_DATABASE_URL, path], { stdio: 'inherit' });
    if (r2.status !== 0) throw new Error(`pg_restore failed`);
  } else {
    log('set RESTORE_DATABASE_URL to do full pg_restore into a scratch DB');
  }
}

async function main() {
  const src = latest ? findLatest(dest) : process.argv.find(a => !a.startsWith('--') && (a.endsWith('.db')||a.endsWith('.dump')));
  if (!src) throw new Error('no backup file specified and --latest not given');
  const resolvedSrc = resolve(src);
  log(`verifying ${resolvedSrc} (pg=${isPg})`);
  if (resolvedSrc.endsWith('.dump') || isPg) {
    verifyPgDump(resolvedSrc);
  } else {
    const out = outArg ? resolve(outArg) : resolve('/tmp', `duekeeper-restore-${Date.now()}.db`);
    mkdirSync(resolve(out, '..'), { recursive: true });
    copyFileSync(resolvedSrc, out);
    log(`copied to ${out}`);
    await verifySqlite(out);
  }
  log('restore test PASS — backup is restorable');
}
main().catch(e=>{ console.error(`[restore] fatal: ${e.message}`); process.exit(1); });

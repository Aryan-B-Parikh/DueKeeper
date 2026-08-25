#!/usr/bin/env node
/**
 * DueKeeper backup — q6h SQLite → object storage, PG pg_dump → object storage, 30d retention.
 * Usage: node scripts/backup.mjs [--dry-run] [--dest s3://bucket/prefix]
 * Env: DATABASE_URL (PG) or DB_PATH (SQLite), BACKUP_DEST (local dir or s3://), BACKUP_RETENTION_DAYS=30
 * For SQLite: uses `VACUUM INTO` (consistent snapshot even with WAL) when available, else file copy.
 * For PG: uses `pg_dump --format=custom` if pg_dump is on PATH.
 * Retention: keeps 30 days by default, deletes older `duekeeper-*.db`/`.dump` in dest.
 * Restore test: `node scripts/restore.mjs --latest --verify` (does pg_restore --list or sqlite integrity_check).
 * A backup never restored is not a backup — run restore test in CI weekly (see .github/workflows/ci.yml).
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const dest = process.env.BACKUP_DEST || process.argv.find(a => a.startsWith('--dest='))?.split('=')[1] || './backups';
const dryRun = process.argv.includes('--dry-run');
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const isPg = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());

function log(msg) { console.log(`[backup] ${new Date().toISOString()} ${msg}`); }

function ensureDest() {
  if (dest.startsWith('s3://')) return; // object storage — upload via aws s3 cp (caller must have AWS CLI)
  mkdirSync(resolve(dest), { recursive: true });
}

function pruneOld() {
  if (dest.startsWith('s3://')) { log(`prune skipped for ${dest} (do via lifecycle policy)`); return; }
  const dir = resolve(dest);
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - retentionDays * 86400_000;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('duekeeper-')) continue;
    const p = join(dir, f);
    try { if (statSync(p).mtimeMs < cutoff) { log(`prune ${f} (>${retentionDays}d)`); if (!dryRun) unlinkSync(p); } } catch {}
  }
}

async function backupSqlite() {
  const dbPath = resolve(process.env.DB_PATH || './data/duekeeper.db');
  if (!existsSync(dbPath)) { log(`SQLite DB not found at ${dbPath} — nothing to backup (fresh install)`); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(dest, `duekeeper-${stamp}.db`);
  ensureDest();
  if (dryRun) { log(`[dry-run] would VACUUM INTO ${out}`); return; }
  // Try VACUUM INTO for consistent snapshot (works with WAL); fallback to file copy
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); log(`SQLite VACUUM INTO ${out}`); }
    finally { db.close(); }
  } catch (e) {
    log(`VACUUM INTO failed (${e.message}) — falling back to file copy`);
    copyFileSync(dbPath, out);
    // also copy wal/shm if present (best-effort, not needed after VACUUM)
    for (const ext of ['-wal', '-shm']) { const p = dbPath + ext; if (existsSync(p)) try { copyFileSync(p, out + ext); } catch {} }
    log(`SQLite file copy ${out}`);
  }
  if (dest.startsWith('s3://')) {
    const r = spawnSync('aws', ['s3', 'cp', out, `${dest}/${basename(out)}`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('aws s3 cp failed');
  }
}

async function backupPg() {
  const url = process.env.DATABASE_URL;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(dest.startsWith('s3://') ? './backups' : dest, `duekeeper-${stamp}.dump`);
  ensureDest();
  if (dryRun) { log(`[dry-run] would pg_dump ${url.replace(/:[^@]+@/, ':***@')} → ${out}`); return; }
  mkdirSync(resolve(dest.startsWith('s3://') ? './backups' : dest), { recursive: true });
  // pg_dump --format=custom is compressed and pg_restore-able
  const args = ['--format=custom', '--no-owner', '--no-acl', '-f', out, url];
  log(`pg_dump → ${out}`);
  const r = spawnSync('pg_dump', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`pg_dump failed (status ${r.status}) — is pg_dump on PATH and DATABASE_URL valid?`);
  if (dest.startsWith('s3://')) {
    const r2 = spawnSync('aws', ['s3', 'cp', out, `${dest}/${basename(out)}`], { stdio: 'inherit' });
    if (r2.status !== 0) throw new Error('aws s3 cp failed');
  }
}

async function main() {
  log(`start dest=${dest} retention=${retentionDays}d pg=${isPg} dryRun=${dryRun}`);
  if (isPg) await backupPg(); else await backupSqlite();
  pruneOld();
  log('done — now test restore: node scripts/restore.mjs --latest --verify');
}
main().catch(e => { console.error(`[backup] fatal: ${e.message}`); process.exit(1); });

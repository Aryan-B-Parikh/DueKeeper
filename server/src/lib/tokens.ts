import { createHash, randomBytes } from 'crypto';
import { prepare, inTransaction } from '../db/database';
import { config } from '../config/env';
import { signJwt } from './jwt';
import { uuid } from './ids';
import { nowIso } from './time';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface UserTokenSource {
  id: string;
  email: string;
  token_version: number;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function issueAccessToken(user: UserTokenSource): string {
  return signJwt(
    { sub: user.id, email: user.email, ver: Number(user.token_version ?? 0) },
    config.jwtSecret,
    config.jwtExpiresIn
  );
}

export function issueTokenPair(user: UserTokenSource): TokenPair {
  const raw = randomBytes(48).toString('base64url');
  prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    user.id,
    hashToken(raw),
    new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000).toISOString(),
    nowIso()
  );
  return { accessToken: issueAccessToken(user), refreshToken: raw };
}

export interface RefreshResult {
  ok: boolean;
  theftDetected?: boolean;
  pair?: TokenPair;
  userId?: string;
}

export function rotateRefreshToken(raw: string): RefreshResult {
  const hash = hashToken(raw);
  const row = prepare(
    `SELECT r.id, r.user_id, r.expires_at, r.revoked_at, r.replaced_by_hash, u.email, u.token_version
     FROM refresh_tokens r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ?`
  ).get(hash) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null; replaced_by_hash: string | null; email: string; token_version: number }
    | undefined;

  if (!row) return { ok: false };

  if (row.revoked_at !== null || row.replaced_by_hash !== null) {
    revokeAllForUser(row.user_id);
    return { ok: false, theftDetected: true, userId: row.user_id };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, userId: row.user_id };
  }

  const nextRaw = randomBytes(48).toString('base64url');
  const nextHash = hashToken(nextRaw);
  inTransaction(() => {
    prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by_hash = ? WHERE id = ?').run(
      nowIso(),
      nextHash,
      row.id
    );
    prepare(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      row.user_id,
      nextHash,
      new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000).toISOString(),
      nowIso()
    );
  });

  return {
    ok: true,
    userId: row.user_id,
    pair: {
      accessToken: issueAccessToken({ id: row.user_id, email: row.email, token_version: row.token_version }),
      refreshToken: nextRaw
    }
  };
}

export function revokeRefreshToken(raw: string): boolean {
  const result = prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'
  ).run(nowIso(), hashToken(raw));
  return result.changes > 0;
}

export function revokeAllForUser(userId: string): void {
  prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
  ).run(nowIso(), userId);
}

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

/**
 * Reuse of an already-rotated refresh token means someone is replaying a stolen
 * one. Revoking the token family alone still leaves the thief's current access
 * token usable until it expires, so the version is bumped too — that
 * invalidates every outstanding access token immediately.
 *
 * Called from inside rotateRefreshToken's transaction, so the whole response is
 * atomic with the detection.
 */
function revokeFamilyOnTheft(userId: string): void {
  prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    nowIso(),
    userId
  );
  prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?').run(
    nowIso(),
    userId
  );
}

export function rotateRefreshToken(raw: string): RefreshResult {
  const hash = hashToken(raw);
  // The read and the subsequent write must be atomic: two concurrent
  // refreshes that both read outside the transaction would both see
  // revoked_at = NULL and both succeed, defeating theft detection.
  return inTransaction(() => {
    const row = prepare(
      `SELECT r.id, r.user_id, r.expires_at, r.revoked_at, r.replaced_by_hash, u.email, u.token_version
       FROM refresh_tokens r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = ?`
    ).get(hash) as
      | { id: string; user_id: string; expires_at: string; revoked_at: string | null; replaced_by_hash: string | null; email: string; token_version: number }
      | undefined;

    if (!row) return { ok: false };

    if (row.revoked_at !== null || row.replaced_by_hash !== null) {
      // Revoke inside the same transaction so the family is fully invalidated
      // before the theft signal is returned.
      revokeFamilyOnTheft(row.user_id);
      return { ok: false, theftDetected: true, userId: row.user_id };
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return { ok: false, userId: row.user_id };
    }

    const nextRaw = randomBytes(48).toString('base64url');
    const nextHash = hashToken(nextRaw);
    const upd = prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by_hash = ? WHERE id = ? AND revoked_at IS NULL').run(
      nowIso(),
      nextHash,
      row.id
    );
    // Guard against a concurrent rotation that already revoked this row.
    if (upd.changes === 0) {
      revokeFamilyOnTheft(row.user_id);
      return { ok: false, theftDetected: true, userId: row.user_id };
    }
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

    return {
      ok: true,
      userId: row.user_id,
      pair: {
        accessToken: issueAccessToken({ id: row.user_id, email: row.email, token_version: row.token_version }),
        refreshToken: nextRaw
      }
    };
  });
}

export function revokeRefreshToken(raw: string): boolean {
  const result = prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'
  ).run(nowIso(), hashToken(raw));
  return result.changes > 0;
}

/**
 * Invalidates every credential a user holds: refresh tokens are revoked and
 * `token_version` is bumped so already-issued access tokens stop verifying.
 *
 * Both halves are required and must land together. Bumping the version alone
 * leaves refresh tokens able to mint new access tokens; revoking refresh tokens
 * alone leaves the current access token valid until it expires. Doing them as
 * two separate statements left a window where a crash in between meant the
 * "sign out everywhere" the user was shown had only partly happened.
 *
 * Returns true if the user existed.
 */
export function revokeAllSessions(userId: string): boolean {
  return inTransaction(() => {
    const result = prepare(
      'UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?'
    ).run(nowIso(), userId);
    prepare(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(nowIso(), userId);
    return result.changes > 0;
  });
}

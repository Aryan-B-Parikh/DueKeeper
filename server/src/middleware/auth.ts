import { verifyJwt } from '../lib/jwt';
import { config } from '../config/env';
import { UnauthorizedError } from '../lib/errors';
import { prepare } from '../db/database';
import type { AuthUser } from './validate';
import type { RequestHandler } from 'express';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  timezone: string;
  token_version: number;
}

/**
 * Resolves a bearer token to a live user, or throws the reason it cannot.
 *
 * Verifying the signature is not by itself authentication here. A JWT stays
 * cryptographically valid until it expires, so revocation has to be re-checked
 * against the database on every single request: the user row may be gone, and
 * `token_version` is bumped by password changes and sign-out-everywhere.
 *
 * This is exported because the SSE stream route needs the same three checks and
 * previously called `verifyJwt` on its own — which meant a header-authenticated
 * stream honoured tokens from sessions that had already been revoked, and kept
 * pushing that account's notifications for the remaining lifetime of the token.
 * Any future non-middleware auth path must come through here for the same reason.
 */
export function authenticateBearer(token: string): AuthUser {
  const payload = verifyJwt(token, config.jwtSecret);
  if (!payload) {
    throw new UnauthorizedError('Invalid or expired token');
  }
  const row = prepare(
    'SELECT id, email, display_name, timezone, token_version FROM users WHERE id = ?'
  ).get(payload.sub) as UserRow | undefined;
  if (!row) {
    throw new UnauthorizedError('Account no longer exists');
  }
  if (Number(row.token_version ?? 0) !== Number(payload.ver ?? 0)) {
    throw new UnauthorizedError('Session revoked; sign in again');
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    timezone: row.timezone
  };
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return next(new UnauthorizedError('Missing bearer token'));
    }
    try {
      req.user = authenticateBearer(match[1]);
    } catch (err) {
      return next(err);
    }
    next();
  };
}

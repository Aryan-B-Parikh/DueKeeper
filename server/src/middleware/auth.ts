import { verifyJwt } from '../lib/jwt';
import { config } from '../config/env';
import { UnauthorizedError } from '../lib/errors';
import { prepare } from '../db/database';
import type { Request, RequestHandler, Response } from 'express';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  timezone: string;
  token_version: number;
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return next(new UnauthorizedError('Missing bearer token'));
    }
    const payload = verifyJwt(match[1], config.jwtSecret);
    if (!payload) {
      return next(new UnauthorizedError('Invalid or expired token'));
    }
    const row = prepare(
      'SELECT id, email, display_name, timezone, token_version FROM users WHERE id = ?'
    ).get(payload.sub) as UserRow | undefined;
    if (!row) {
      return next(new UnauthorizedError('Account no longer exists'));
    }
    if (Number(row.token_version ?? 0) !== Number(payload.ver ?? 0)) {
      return next(new UnauthorizedError('Session revoked; sign in again'));
    }
    req.user = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      timezone: row.timezone
    };
    next();
  };
}

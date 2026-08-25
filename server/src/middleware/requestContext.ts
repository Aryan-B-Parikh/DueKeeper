import type { RequestHandler } from 'express';
import { shortId } from '../lib/ids';

/**
 * Tags the request with a correlation id and echoes it back.
 *
 * Security headers deliberately do *not* live here: they used to, duplicating
 * the set in createApp, and because this middleware runs second its
 * `default-src 'none'` CSP silently overwrote the app-level one. Two places
 * setting the same headers with different values means the effective policy
 * depends on mount order, so there is now exactly one source of truth (app.ts).
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    req.requestId = shortId();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

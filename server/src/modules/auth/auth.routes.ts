import { Router } from 'express';
import { z } from 'zod';
import { handler, parseWith } from '../../middleware/validate';
import { registerUser, loginUser, toPublicUser } from './auth.service';
import { requireAuth } from '../../middleware/auth';
import { getUserRowById } from './auth.service';
import { createRateLimiter } from '../../lib/rateLimit';
import { RateLimitError, UnauthorizedError } from '../../lib/errors';
import { rotateRefreshToken, revokeRefreshToken } from '../../lib/tokens';
import { config } from '../../config/env';

export const authRouter = Router();

const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: config.loginRateLimit });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: config.registerRateLimit });

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const registerSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Display name is required').max(80)
});

const loginSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
  password: z.string().min(1, 'Password is required')
});

function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();
  return forwarded || req.ip || 'local';
}

authRouter.post(
  '/register',
  handler(async (req, res) => {
    const limit = registerLimiter.take(clientIp(req));
    if (!limit.allowed) {
      throw new RateLimitError(limit.retryAfterSeconds, 'Too many registrations; try again later');
    }
    const body = parseWith(registerSchema, req.body);
    const result = registerUser(body);
    res.status(201).json(result);
  })
);

authRouter.post(
  '/login',
  handler(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'anonymous';
    const limit = loginLimiter.take(`${email}|${clientIp(req)}`);
    if (!limit.allowed) {
      throw new RateLimitError(limit.retryAfterSeconds, 'Too many sign-in attempts; try again later');
    }
    const body = parseWith(loginSchema, req.body);
    const result = loginUser(body.email, body.password);
    res.json(result);
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

authRouter.post(
  '/refresh',
  handler(async (req, res) => {
    const body = parseWith(refreshSchema, req.body);
    const result = rotateRefreshToken(body.refreshToken);
    if (!result.ok || !result.pair) {
      throw new UnauthorizedError('Invalid refresh token');
    }
    res.json(result.pair);
  })
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    const raw = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (raw.length >= 20) revokeRefreshToken(raw);
    res.status(204).send();
  })
);

authRouter.get(
  '/me',
  requireAuth(),
  handler(async (req, res) => {
    const row = getUserRowById(req.user!.id);
    if (!row) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Account no longer exists' } });
      return;
    }
    res.json({ user: toPublicUser(row) });
  })
);

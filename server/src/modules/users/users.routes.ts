import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { handler, parseWith } from '../../middleware/validate';
import { prepare } from '../../db/database';
import { toPublicUser, getUserRowById, insertNotification } from '../auth/auth.service';
import { config } from '../../config/env';
import { nowIso } from '../../lib/time';
import { hashPassword, verifyPassword } from '../../lib/password';
import { UnauthorizedError, ValidationError } from '../../lib/errors';
import { getVapidKeys } from '../../lib/push/vapid';
import { uuid } from '../../lib/ids';

export const usersRouter = Router();

usersRouter.use(requireAuth());

const TIMEZONE_RE = /^[A-Za-z_]+\/[A-Za-z_0-9+\-]+$/;

function isValidTimezone(tz: string): boolean {
  if (tz === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  timezone: z
    .string()
    .trim()
    .refine((v) => v === 'UTC' || TIMEZONE_RE.test(v), 'Timezone must be an IANA identifier')
    .refine((v) => isValidTimezone(v), 'Unknown timezone')
    .optional(),
  notificationPrefs: z
    .object({
      reminderEmails: z.boolean().optional(),
      dueSoonAlerts: z.boolean().optional()
    })
    .optional()
});

usersRouter.get(
  '/profile',
  handler(async (req, res) => {
    const row = getUserRowById(req.user!.id);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    const tokenRow = prepare('SELECT forwarding_token FROM users WHERE id = ?').get(req.user!.id) as {
      forwarding_token: string;
    };
    res.json({
      user: toPublicUser(row),
      forwardingAddress: `deadline+${tokenRow.forwarding_token}@${config.inboxDomain}`,
      inboxConfigured: Boolean(config.inboxWebhookToken)
    });
  })
);

usersRouter.put(
  '/profile',
  handler(async (req, res) => {
    const body = parseWith(profileUpdateSchema, req.body);
    const row = getUserRowById(req.user!.id);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });

    let prefs = {};
    try {
      prefs = JSON.parse(row.notification_prefs) as Record<string, boolean>;
    } catch {
      prefs = {};
    }

    const displayName = body.displayName ?? row.display_name;
    const timezone = body.timezone ?? row.timezone;
    const mergedPrefs = { ...prefs, ...(body.notificationPrefs ?? {}) };

    prepare(
      'UPDATE users SET display_name = ?, timezone = ?, notification_prefs = ?, updated_at = ? WHERE id = ?'
    ).run(displayName, timezone, JSON.stringify(mergedPrefs), nowIso(), req.user!.id);

    const updated = getUserRowById(req.user!.id)!;
    res.json({ user: toPublicUser(updated) });
  })
);

usersRouter.get(
  '/profile/forwarding-token',
  handler(async (req, res) => {
    const row = prepare('SELECT forwarding_token FROM users WHERE id = ?').get(req.user!.id) as
      | { forwarding_token: string }
      | undefined;
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    res.json({
      forwardingToken: row.forwarding_token,
      address: `deadline+${row.forwarding_token}@${config.inboxDomain}`
    });
  })
);

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
});

usersRouter.post(
  '/password',
  handler(async (req, res) => {
    const body = parseWith(passwordChangeSchema, req.body);
    const row = getUserRowById(req.user!.id);
    if (!row || !verifyPassword(body.currentPassword, row.password_hash)) {
      throw new UnauthorizedError('Incorrect current password');
    }
    if (verifyPassword(body.newPassword, row.password_hash)) {
      return res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'New password must differ from the current one' }
      });
    }
    prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?').run(
      hashPassword(body.newPassword),
      nowIso(),
      req.user!.id
    );
    res.json({ ok: true, sessionsRevoked: true });
  })
);

usersRouter.post(
  '/sessions/revoke-all',
  handler(async (req, res) => {
    const result = prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user!.id);
    res.json({ ok: result.changes > 0 });
  })
);

function pushKeysAvailable(): boolean {
  return Boolean(getVapidKeys());
}

function countExpoDevices(userId: string): number {
  const row = prepare('SELECT COUNT(*) AS c FROM expo_push_tokens WHERE user_id = ?').get(userId) as {
    c: number;
  };
  return Number(row.c);
}

usersRouter.get(
  '/push/public-key',
  handler(async (_req, res) => {
    if (!pushKeysAvailable()) {
      return res.json({ available: false, publicKey: null });
    }
    res.json({ available: true, publicKey: getVapidKeys()!.publicKey });
  })
);

const expoTokenSchema = z.object({ token: z.string().min(10).max(255) });

usersRouter.post(
  '/push/expo',
  handler(async (req, res) => {
    const body = parseWith(expoTokenSchema, req.body);
    prepare(
      `INSERT INTO expo_push_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`
    ).run(uuid(), req.user!.id, body.token, nowIso());
    res.status(201).json({ ok: true });
  })
);

usersRouter.delete(
  '/push/expo',
  handler(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    prepare('DELETE FROM expo_push_tokens WHERE token = ? AND user_id = ?').run(token, req.user!.id);
    res.json({ ok: true });
  })
);

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(40).max(200),
    auth: z.string().min(16).max(200)
  })
});

usersRouter.post(
  '/push/subscribe',
  handler(async (req, res) => {
    if (!pushKeysAvailable()) throw new ValidationError('Push is not available on this server');
    const body = parseWith(subscribeSchema, req.body);
    prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`
    ).run(uuid(), req.user!.id, body.endpoint, body.keys.p256dh, body.keys.auth, nowIso());
    res.status(201).json({ ok: true });
  })
);

usersRouter.post(
  '/push/unsubscribe',
  handler(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user!.id);
    res.json({ ok: true });
  })
);

usersRouter.get(
  '/push/status',
  handler(async (req, res) => {
    const row = prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(req.user!.id) as {
      c: number;
    };
    res.json({ available: pushKeysAvailable(), subscribedDevices: Number(row.c), expoDevices: countExpoDevices(req.user!.id) });
  })
);

usersRouter.post(
  '/push/test',
  handler(async (req, res) => {
    const { sendPushToUser } = await import('../../engine/push.service');
    const { sendExpoToUser } = await import('../../engine/expoPush.service');
    const [webResult, expoResult] = await Promise.all([
      sendPushToUser(req.user!.id, {
        title: 'DueKeeper push is live',
        body: 'If you can read this on your device, reminders will reach you even with the tab closed.',
        url: '/dashboard'
      }),
      sendExpoToUser(req.user!.id, {
        title: 'DueKeeper push is live',
        body: 'Mobile reminders are connected.',
        url: 'duekeeper://(tabs)/notifications'
      })
    ]);
    res.json({
      sent: webResult.sent,
      removed: webResult.removed,
      expoSent: expoResult.sent,
      expoRemoved: expoResult.removed
    });
  })
);

usersRouter.get(
  '/export',
  handler(async (req, res) => {
    const userRow = getUserRowById(req.user!.id);
    if (!userRow) throw new UnauthorizedError();
    const events = prepare(
      `SELECT e.*, (SELECT json_group_array(json_object('offsetSeconds', r.offset_seconds, 'channel', r.channel, 'enabled', r.enabled))
                      FROM reminders r WHERE r.event_id = e.id) AS reminders
       FROM events e WHERE e.user_id = ? ORDER BY e.due_at ASC`
    ).all(req.user!.id);
    const notifications = prepare(
      'SELECT id, event_id, type, title, body, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user!.id);
    const exportPayload = {
      exportedAt: nowIso(),
      formatVersion: 1,
      profile: toPublicUser(userRow),
      forwardingAddress: `deadline+${userRow.forwarding_token}@${config.inboxDomain}`,
      events,
      notifications
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="duekeeper-export.json"');
    res.json(exportPayload);
  })
);

usersRouter.delete(
  '/profile',
  handler(async (req, res) => {
    const result = prepare('DELETE FROM users WHERE id = ?').run(req.user!.id);
    if (result.changes === 0) throw new UnauthorizedError();
    res.status(204).send();
  })
);

export function notifyUser(
  userId: string,
  type: 'reminder' | 'system' | 'info' | 'warning',
  title: string,
  message: string,
  options?: { eventId?: string | null; idempotencyKey?: string }
): void {
  insertNotification(userId, type, title, message, options);
}

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth';
import { handler } from '../../middleware/validate';
import { prepare } from '../../db/database';
import { NotFoundError, BadRequestError, UnauthorizedError } from '../../lib/errors';
import { verifyJwt } from '../../lib/jwt';
import { config } from '../../config/env';
import { subscribe, unsubscribe } from '../../engine/hub';

export const notificationsRouter = Router();

interface NotificationRow {
  id: string;
  user_id: string;
  event_id: string | null;
  type: string;
  title: string;
  body: string;
  read: 0 | 1;
  created_at: string;
}

function mapRow(row: NotificationRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read: row.read === 1,
    createdAt: row.created_at
  };
}

function countUnread(userId: string): number {
  const row = prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(
    userId
  ) as { c: number };
  return Number(row.c);
}

notificationsRouter.get(
  '/',
  requireAuth(),
  handler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
    const rows = (
      unreadOnly
        ? prepare('SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ?')
        : prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    ).all(req.user!.id, limit) as unknown as NotificationRow[];
    res.json({ notifications: rows.map(mapRow), unreadCount: countUnread(req.user!.id) });
  })
);

notificationsRouter.get(
  '/unread-count',
  requireAuth(),
  handler(async (req, res) => {
    res.json({ unreadCount: countUnread(req.user!.id) });
  })
);

notificationsRouter.post(
  '/read-all',
  requireAuth(),
  handler(async (req, res) => {
    prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.user!.id);
    res.json({ ok: true });
  })
);

notificationsRouter.post(
  '/:id/read',
  requireAuth(),
  handler(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      throw new BadRequestError('Invalid notification id');
    }
    const result = prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(
      req.params.id,
      req.user!.id
    );
    if (result.changes === 0) throw new NotFoundError('Notification');
    res.json({ ok: true });
  })
);

notificationsRouter.get('/stream', (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = verifyJwt(token, config.jwtSecret);
  if (!payload) {
    throw new UnauthorizedError('Missing or invalid stream token');
  }
  const userId = payload.sub;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n\n');

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('unread', { count: countUnread(userId) });

  const listener = subscribe(userId, (event, data) => send(event, data));
  const heartbeat = setInterval(() => {
    res.write(':ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(userId, listener);
  });
});

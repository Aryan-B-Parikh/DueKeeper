import { Router, type Request, type Response } from 'express';
import { requireAuth, authenticateBearer } from '../../middleware/auth';
import { handler } from '../../middleware/validate';
import { prepare, queryAll, queryOne } from '../../db/database';
import { NotFoundError, BadRequestError, UnauthorizedError, RateLimitError } from '../../lib/errors';
import { config } from '../../config/env';
import { subscribe, unsubscribe, countSubscriptions } from '../../engine/hub';
import { createLogger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rateLimit';
import { consumeStreamTicket, issueStreamTicket } from '../../lib/streamTicket';
import { parsePageRequest, pageMeta } from '../../lib/pagination';

const log = createLogger('sse');

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
  const row = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0', userId)!;
  return Number(row.c);
}

notificationsRouter.get(
  '/',
  requireAuth(),
  handler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
    const page = parsePageRequest(req.query as Record<string, unknown>, {
      defaultLimit: 50,
      maxLimit: config.maxListPageSize
    });
    // The predicate is written once and shared by the page and the count, so the
    // total can never describe a different set than the rows.
    const predicate = unreadOnly ? 'user_id = ? AND read = 0' : 'user_id = ?';
    const rows = queryAll<NotificationRow>(
      `SELECT * FROM notifications WHERE ${predicate}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      req.user!.id,
      page.limit,
      page.offset
    );
    const totalRow = queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications WHERE ${predicate}`, req.user!.id)!;
    res.json({
      notifications: rows.map(mapRow),
      unreadCount: countUnread(req.user!.id),
      page: pageMeta(page, Number(totalRow.c))
    });
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

const ticketLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

/**
 * Mints the single-use ticket that `GET /stream` accepts in its query string.
 *
 * This exists because `EventSource` cannot send an `Authorization` header, so
 * something has to travel in the URL. A ticket is the safe thing to put there:
 * see lib/streamTicket.ts for why the access token is not.
 */
notificationsRouter.post(
  '/stream-ticket',
  requireAuth(),
  handler(async (req, res) => {
    const limit = ticketLimiter.take(req.user!.id);
    if (!limit.allowed) {
      throw new RateLimitError(limit.retryAfterSeconds, 'Too many stream ticket requests');
    }
    const issued = issueStreamTicket(req.user!.id);
    res.json({ ticket: issued.ticket, expiresIn: issued.expiresInSeconds });
  })
);

/**
 * Open SSE responses, tracked so shutdown can end them.
 *
 * An event stream never completes on its own, so `server.close()` waits on it
 * forever and a graceful shutdown degrades into the hard kill timeout.
 */
const openStreams = new Set<Response>();

/** Ends every live stream. Returns how many were closed. */
export function closeNotificationStreams(): number {
  const count = openStreams.size;
  for (const res of openStreams) {
    try {
      res.write('event: shutdown\ndata: {}\n\n');
      res.end();
    } catch {
      /* already gone */
    }
  }
  openStreams.clear();
  return count;
}

notificationsRouter.get('/stream', (req: Request, res: Response) => {
  // Two ways in: an Authorization header for non-browser clients (curl, tests,
  // native apps), or a single-use ticket for EventSource. The old ?token=
  // fallback is gone — it put a full-lifetime access JWT in every access log.
  const headerAuth = req.headers.authorization as string | undefined;
  const headerToken = headerAuth?.toLowerCase().startsWith('bearer ')
    ? headerAuth.slice(7).trim()
    : '';

  let userId: string;
  if (headerToken) {
    // Goes through the same helper `requireAuth` uses. Calling `verifyJwt` here
    // directly (the previous shape) skipped the account-exists and
    // `token_version` checks, so a session revoked by a password change or
    // sign-out-everywhere could still open a stream and keep receiving that
    // account's notifications until the token expired.
    userId = authenticateBearer(headerToken).id;
  } else {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const ticketUser = ticket ? consumeStreamTicket(ticket) : null;
    if (!ticketUser) {
      if (typeof req.query.token === 'string' && req.query.token) {
        // Old clients hit this. Say so plainly rather than looking like an auth bug.
        throw new UnauthorizedError(
          'Stream tokens in the query string are no longer accepted; POST /api/notifications/stream-ticket and pass ?ticket='
        );
      }
      throw new UnauthorizedError('Missing or invalid stream ticket');
    }
    // Ticket now carries tokenVersion (stored at issue time); consumeStreamTicket already
    // rejected if the account's token_version moved (e.g. revoke-all). Still check existence
    // for the DB-hiccup fail-open path.
    const exists = queryOne<{ ok: number }>('SELECT 1 AS ok FROM users WHERE id = ?', ticketUser);
    if (!exists) throw new UnauthorizedError('Account no longer exists');
    userId = ticketUser;
  }

  if (countSubscriptions(userId) >= config.sseMaxConnectionsPerUser) {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many stream connections' } });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const ok = res.write('retry: 5000\n\n');
  if (!ok) {
    // Slow client already signaled backpressure on the headers; close to avoid unbounded buffering.
    res.end();
    return;
  }
  openStreams.add(res);

  const send = (event: string, data: unknown): boolean => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const flushed = res.write(chunk);
    if (!flushed) {
      log.warn(`SSE backpressure for user ${userId.slice(0, 8)}… — closing slow connection`);
      // Let the close handler clean up, but end the response to free the buffer.
      openStreams.delete(res);
      res.end();
    }
    return flushed;
  };

  send('unread', { count: countUnread(userId) });

  const listener = subscribe(userId, (event, data) => {
    if (!send(event, data)) {
      clearInterval(heartbeat);
      unsubscribe(userId, listener);
    }
  });
  const heartbeat = setInterval(() => {
    if (!res.write(':ping\n\n')) {
      clearInterval(heartbeat);
      unsubscribe(userId, listener);
      openStreams.delete(res);
      res.end();
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(userId, listener);
    openStreams.delete(res);
  });
});

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config/env';
import { requestContext } from './middleware/requestContext';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { metrics, snapshotMetrics } from './lib/metrics';
import { renderPrometheus } from './lib/prometheus';
import { outboxQueueDepth } from './engine/outbox';
import { requireAuth } from './middleware/auth';
import { healthRouter } from './health/health.routes';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { eventsRouter } from './modules/events/events.routes';
import { extractRouter } from './modules/extract/extract.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { calendarRouter } from './modules/calendar/calendar.routes';
import { inboxRouter } from './modules/inbox/inbox.routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // The single place security headers are set. This server only ever answers
  // with JSON, an .ics download or a redirect, so the CSP can be the strictest
  // one available — `'self'` would only be needed if it served its own HTML.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(requestContext());

  app.use((req: Request, res: Response, next: NextFunction) => {
    metrics.requestsTotal += 1;
    res.on('finish', () => {
      const status = res.statusCode;
      if (status >= 500) metrics.responses5xx += 1;
      else if (status === 401 || status === 403) metrics.authFailures += 1;
    });
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsAllowedOrigins.includes(origin.replace(/\/$/, ''))) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/api/auth', authRouter);
  app.use('/api/user', usersRouter);
  // The more specific prefix has to be mounted first: eventsRouter's `GET /:id`
  // otherwise matches `/api/events/extract` and answers 404 before this router
  // is ever consulted.
  app.use('/api/events/extract', extractRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api/health', healthRouter);

  app.get('/api/metrics', requireAuth(), (_req, res) => {
    res.json({ ...snapshotMetrics(), outbox: outboxQueueDepth() });
  });

  // Prometheus scrape endpoint — unauthenticated by default (scraper is internal),
  // but if PROMETHEUS_TOKEN is set, require Bearer or ?token (so public internet cannot enumerate behavior).
  app.get('/metrics', (req, res) => {
    const token = process.env.PROMETHEUS_TOKEN;
    if (token) {
      const auth = (req.headers.authorization as string)?.replace(/^Bearer\s+/i, '') ?? (req.query.token as string) ?? '';
      if (auth !== token) { res.status(401).send('Unauthorized'); return; }
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderPrometheus());
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

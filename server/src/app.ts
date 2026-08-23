import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config/env';
import { requestContext } from './middleware/requestContext';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { metrics, snapshotMetrics } from './lib/metrics';
import { requireAuth } from './middleware/auth';

function requireAuthHandler() {
  return requireAuth();
}
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
  app.use('/api/events', eventsRouter);
  app.use('/api/events/extract', extractRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api/health', healthRouter);

  app.get('/api/metrics', requireAuth(), (_req, res) => {
    res.json(snapshotMetrics());
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

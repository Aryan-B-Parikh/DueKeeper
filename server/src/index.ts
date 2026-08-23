import { createApp } from './app';
import { config } from './config/env';
import { runMigrations } from './db/migrate';
import { startPlanner, stopPlanner } from './engine/planner';
import { startOutboxWorker, stopOutboxWorker } from './engine/outbox';
import { closeDb } from './db/database';
import { createLogger } from './lib/logger';

const log = createLogger('server');

async function main(): Promise<void> {
  runMigrations();

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`DueKeeper API listening on port ${config.port} (${config.nodeEnv})`);
    log.info(`CORS origins: ${config.corsAllowedOrigins.join(', ')}`);
    if (!config.geminiApiKey) {
      log.warn('GEMINI_API_KEY missing: screenshot AI extraction disabled; heuristic text parser active');
    }
    if (!config.smtpHost) {
      log.warn('SMTP_HOST missing: emails will be logged to console instead of sent');
    }
    if (!config.inboxWebhookToken) {
      log.warn('INBOX_WEBHOOK_TOKEN missing: email inbox forwarding disabled');
    }
    if (!config.googleClientId) {
      log.warn('GOOGLE_CLIENT_ID missing: Google Calendar sync disabled (ICS import/export still works)');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Port ${config.port} is already in use. Another DueKeeper instance is probably still running.` +
          ' Stop it first, or start this one on a different port with PORT=<other> npm run dev.'
      );
      process.exit(1);
      return;
    }
    throw err;
  });

  startPlanner();
  startOutboxWorker();

  const shutdown = (signal: string): void => {
    log.info(`${signal} received; shutting down gracefully`);
    stopPlanner();
    stopOutboxWorker();
    server.close(() => {
      try {
        closeDb();
      } catch (err) {
        log.warn('Error closing database', err as Error);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Fatal startup error', err as Error);
  process.exit(1);
});

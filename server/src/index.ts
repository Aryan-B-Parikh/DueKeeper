import { createApp } from './app';
import { config } from './config/env';
import { runMigrations } from './db/migrate';
import { startPlanner, stopPlanner } from './engine/planner';
import { startOutboxWorker, stopOutboxWorker, outboxBusy } from './engine/outbox';
import { closeNotificationStreams } from './modules/notifications/notifications.routes';
import { closeDb } from './db/database';
import { closePgPool } from './db/pg';
import { closeRedis } from './lib/redis';
import { createLogger } from './lib/logger';
import { metrics } from './lib/metrics';

const log = createLogger('server');

/** How long in-flight SMTP/push round-trips get to finish before we stop waiting. */
const DRAIN_TIMEOUT_MS = 10_000;
/** Backstop for a socket or handle that refuses to release. */
const HARD_EXIT_MS = 20_000;

// Both counters feed /api/metrics: a log line is only seen by someone reading
// logs, whereas a non-zero counter is something an alert can fire on. Every one
// of these is a bug that escaped a `try`, so the number should stay at zero.
process.on('unhandledRejection', (reason) => {
  metrics.unhandledErrors += 1;
  log.error('Unhandled rejection', reason as Error);
});
process.on('uncaughtException', (err) => {
  metrics.unhandledErrors += 1;
  log.error('Uncaught exception', err as Error);
  // Best-effort checkpoint. SQLite recovers from a dirty WAL, but closing cleanly
  // means the next boot does not have to.
  try {
    closeDb();
  } catch {
    /* nothing useful left to do */
  }
  process.exit(1);
});

async function main(): Promise<void> {
  await runMigrations();

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

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGINT should not restart the drain from the top.
    if (shuttingDown) {
      log.warn(`${signal} received during shutdown; forcing exit`);
      process.exit(1);
      return;
    }
    shuttingDown = true;
    log.info(`${signal} received; shutting down gracefully`);

    // Stop taking on new work first, so the drain below has a finite amount left.
    stopPlanner();
    stopOutboxWorker();

    // An event stream never ends on its own, so server.close() would wait on it
    // forever and every shutdown would hit the hard timeout.
    const streams = closeNotificationStreams();
    if (streams > 0) log.info(`Closed ${streams} live notification stream(s)`);

    server.close();
    server.closeIdleConnections();

    const finish = (): void => {
      try {
        closeDb();
        closePgPool();
        void closeRedis().catch(() => {});
      } catch (err) {
        log.warn('Error closing database', err as Error);
      }
      log.info('Shutdown complete');
      process.exit(0);
    };

    // Poll drain — lets a mid-SMTP reminder finish; quiet server exits immediately (was flat 5s sleep).
    void (async () => {
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (outboxBusy() && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (outboxBusy()) log.warn('Outbox still in flight at the drain deadline; closing anyway');
      finish();
    })();

    setTimeout(() => {
      log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, HARD_EXIT_MS).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Fatal startup error', err as Error);
  process.exit(1);
});

import { prepare, inTransaction, getDb } from '../db/database';
import { createLogger } from '../lib/logger';
import { nowIso } from '../lib/time';
import { config } from '../config/env';
import type { OutboxPayload } from './channels/deliver';
import { PermanentDeliveryError, deliverInApp, deliverEmail } from './channels/deliver';
import { emailService } from './channels/emailChannel';
import { metrics } from '../lib/metrics';

const log = createLogger('outbox');

interface OutboxRow {
  id: string;
  delivery_id: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

let timer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let running = false;

export function startOutboxWorker(): void {
  void processOnce();
  timer = setInterval(() => void processOnce(), 30_000);
  watchdogTimer = setInterval(() => reclaimExpiredLeases(), 60_000);
  log.info('Outbox worker started (interval=30s)');
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  timer = null;
  watchdogTimer = null;
}

function reclaimExpiredLeases(): void {
  try {
    const cutoff = new Date(Date.now() - config.outboxLeaseSeconds * 1000).toISOString();
    const result = prepare(
      `UPDATE notification_outbox
       SET status = 'pending', lease_until = NULL, processing_started_at = NULL, updated_at = ?
       WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?`
    ).run(nowIso(), cutoff);
    if (result.changes > 0) {
      log.warn(`Reclaimed ${result.changes} stale outbox job(s) whose leases expired`);
    }
  } catch (err) {
    log.error('Lease watchdog failed', err as Error);
  }
}

function claimJobs(): OutboxRow[] {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const candidates = db
      .prepare(
        `SELECT id FROM notification_outbox
         WHERE status = 'pending' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC LIMIT ?`
      )
      .all(nowIso(), config.outboxClaimLimit) as Array<{ id: string }>;

    if (candidates.length === 0) {
      db.exec('COMMIT');
      return [];
    }

    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const leaseUntil = new Date(Date.now() + config.outboxLeaseSeconds * 1000).toISOString();

    const rows = db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'processing',
             processing_started_at = ?,
             lease_until = ?,
             attempts = attempts + 1,
             updated_at = ?
         WHERE id IN (${placeholders})
         RETURNING id, delivery_id, payload, attempts, max_attempts`
      )
      .all(...[nowIso(), leaseUntil, nowIso(), ...ids]) as unknown as OutboxRow[];

    db.exec('COMMIT');
    return rows;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
}

async function processJob(row: OutboxRow): Promise<void> {
  let payload: OutboxPayload;
  try {
    payload = JSON.parse(row.payload) as OutboxPayload;
  } catch {
    markFailed(row.id, row.attempts >= row.max_attempts ? 'max-attempts' : 'retry', 'Unparseable outbox payload');
    return;
  }

  const event = prepare('SELECT title, due_at, timezone FROM events WHERE id = ?').get(payload.eventId) as
    | { title: string; due_at: string; timezone: string }
    | undefined;

  if (!event) {
    finishSent(row.id);
    return;
  }

  const resolvedEvent = { title: event.title, dueAt: event.due_at, timezone: event.timezone };

  try {
    if (payload.channel === 'email') {
      const recipient = prepare('SELECT email FROM users WHERE id = ?').get(payload.userId) as
        | { email: string }
        | undefined;
      await deliverEmail(payload, resolvedEvent, (mail) => emailService.sendRaw(mail), recipient?.email ?? '');
    } else {
      await deliverInApp(payload, resolvedEvent);
    }
    finishSent(row.id);
    markDelivery(row.delivery_id, 'sent');
    metrics.remindersSent += 1;
  } catch (err) {
    const permanent =
      err instanceof PermanentDeliveryError ||
      ((err as Error).name === 'PermanentDeliveryError');
    if (permanent || row.attempts >= row.max_attempts) {
      const reason = permanent ? 'permanent-error' : 'max-attempts';
      markFailed(row.id, reason, (err as Error).message ?? 'delivery failed');
      markDelivery(row.delivery_id, 'failed');
      metrics.remindersFailed += 1;
    } else {
      scheduleRetry(row.id, row.attempts, (err as Error).message ?? 'delivery failed');
    }
  }
}

function finishSent(outboxId: string): void {
  prepare(
    `UPDATE notification_outbox SET status = 'sent', sent_at = ?, lease_until = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  ).run(nowIso(), nowIso(), outboxId);
}

function scheduleRetry(outboxId: string, attempts: number, errorMessage: string): void {
  const backoffMs = Math.min(600_000, 30_000 * Math.pow(2, Math.max(0, attempts - 1)));
  prepare(
    `UPDATE notification_outbox
     SET status = 'pending', next_retry_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  ).run(new Date(Date.now() + backoffMs).toISOString(), errorMessage.slice(0, 500), nowIso(), outboxId);
  log.warn(`Outbox job ${outboxId} failed (attempt ${attempts}); retry in ${Math.round(backoffMs / 1000)}s`, errorMessage);
}

function markFailed(outboxId: string, reason: string, errorMessage: string): void {
  prepare(
    `UPDATE notification_outbox SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
     WHERE id = ?`
  ).run(`${reason}: ${errorMessage}`.slice(0, 500), nowIso(), outboxId);
  log.error(`Outbox job ${outboxId} permanently failed (${reason})`);
}

function markDelivery(deliveryId: string, status: 'sent' | 'failed'): void {
  prepare(`UPDATE reminder_deliveries SET status = ?, sent_at = ? WHERE id = ?`).run(
    status,
    status === 'sent' ? nowIso() : null,
    deliveryId
  );
}

export async function processOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const jobs = claimJobs();
    for (const job of jobs) {
      await processJob(job);
    }
    return jobs.length;
  } catch (err) {
    log.error('Outbox processing cycle failed', err as Error);
    return 0;
  } finally {
    running = false;
  }
}

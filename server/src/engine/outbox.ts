import { prepare, inTransaction, queryAll, queryOne } from '../db/database';
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
let deferred = false;
let inFlight = 0;

export function startOutboxWorker(): void {
  void processOnce();
  timer = setInterval(() => void processOnce(), 30_000);
  watchdogTimer = setInterval(() => reclaimExpiredLeases(), 60_000);
  log.info(
    `Outbox worker started (interval=30s, concurrency=${config.outboxConcurrency}, lease=${config.outboxLeaseSeconds}s)`
  );
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  timer = null;
  watchdogTimer = null;
}

/** True while a cycle still has deliveries in flight, so shutdown can drain. */
export function outboxBusy(): boolean {
  return running || inFlight > 0;
}

function reclaimExpiredLeases(): void {
  try {
    const now = nowIso();
    // Lease already encodes expiry (claimTime + leaseSeconds). Comparing directly
    // to now gives the configured recovery time; the previous
    // `now - leaseSeconds` doubled the wait to 2× lease.
    //
    // An expired lease means the worker vanished, not that the remote end refused
    // delivery, so the attempt is refunded. `reclaims` is budgeted separately so
    // a job that reliably kills its worker still dead-letters instead of looping.
    const result = prepare(
      `UPDATE notification_outbox
       SET status = 'pending',
           lease_until = NULL,
           processing_started_at = NULL,
           attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           reclaims = reclaims + 1,
           last_error = 'lease-expired: reclaimed',
           updated_at = ?
       WHERE status = 'processing'
         AND lease_until IS NOT NULL
         AND lease_until < ?
         AND reclaims < ?`
    ).run(now, now, config.outboxMaxReclaims);
    if (result.changes > 0) {
      metrics.outboxReclaimed += Number(result.changes);
      log.warn(`Reclaimed ${result.changes} stale outbox job(s) whose leases expired`);
    }
    // Jobs that have been reclaimed too many times are crash-looping — dead-letter them.
    const dead = prepare(
      `UPDATE notification_outbox
       SET status = 'failed', lease_until = NULL, last_error = 'dead-letter: too many reclaims', updated_at = ?
       WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ? AND reclaims >= ?`
    ).run(now, now, config.outboxMaxReclaims);
    if (dead.changes > 0) {
      metrics.outboxDeadLettered += Number(dead.changes);
      log.error(`Dead-lettered ${dead.changes} job(s) after ${config.outboxMaxReclaims} reclaims`);
    }
  } catch (err) {
    log.error('Lease watchdog failed', err as Error);
  }
}

function claimJobs(): OutboxRow[] {
  return inTransaction(() => {
    const now = nowIso();

    // AUDIT C2: backoff deadline must be in predicate (see AUDIT.md §9).
    const candidates = queryAll<{ id: string }>(
      `SELECT id FROM notification_outbox
       WHERE status = 'pending'
         AND scheduled_at <= ?
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY COALESCE(next_retry_at, scheduled_at) ASC
       LIMIT ?`,
      now,
      now,
      config.outboxClaimLimit
    );

    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const leaseUntil = new Date(Date.now() + config.outboxLeaseSeconds * 1000).toISOString();

    return queryAll<OutboxRow>(
      `UPDATE notification_outbox
       SET status = 'processing',
           processing_started_at = ?,
           lease_until = ?,
           attempts = attempts + 1,
           updated_at = ?
       WHERE id IN (${placeholders})
       RETURNING id, delivery_id, payload, attempts, max_attempts`,
      now,
      leaseUntil,
      now,
      ...ids
    );
  });
}

/**
 * Pushes this job's lease out and confirms we still hold it.
 *
 * The whole batch is claimed under one lease, so jobs waiting their turn behind
 * slower ones were burning lease time they never got to use — the tail of a
 * large batch could expire and be redelivered by the watchdog while still queued
 * here. Renewing at the moment of delivery gives every job a full lease.
 *
 * Returns false if another worker has taken the job over, in which case this
 * worker must not touch it.
 */
function renewLease(outboxId: string): boolean {
  const leaseUntil = new Date(Date.now() + config.outboxLeaseSeconds * 1000).toISOString();
  const result = prepare(
    `UPDATE notification_outbox SET lease_until = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  ).run(leaseUntil, nowIso(), outboxId);
  return result.changes > 0;
}

async function processJob(row: OutboxRow): Promise<void> {
  if (!renewLease(row.id)) {
    log.warn(`Skipping outbox job ${row.id}: lease no longer held by this worker`);
    return;
  }

  let payload: OutboxPayload;
  try {
    const parsed = JSON.parse(row.payload) as OutboxPayload;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.eventId !== 'string') {
      throw new Error('payload missing required fields');
    }
    payload = parsed;
  } catch {
    // An unparseable payload will never become parseable, so retrying it just
    // burns attempts and delays the rest of the queue.
    settle(row, 'failed', 'permanent-error: unparseable outbox payload');
    return;
  }

  const event = queryOne<{ title: string; due_at: string; timezone: string }>(
    'SELECT title, due_at, timezone FROM events WHERE id = ?',
    payload.eventId
  );

  if (!event) {
    // The event was deleted after this job was queued. Nothing to deliver, and
    // the delivery row has to be closed out too or it stays pending forever
    // (reconciliation joins events, so it can never see this row again).
    settle(row, 'cancelled', null);
    return;
  }

  const resolvedEvent = { title: event.title, dueAt: event.due_at, timezone: event.timezone };

  try {
    if (payload.channel === 'email') {
      const recipient = queryOne<{ email: string }>('SELECT email FROM users WHERE id = ?', payload.userId);
      await deliverEmail(payload, resolvedEvent, (mail) => emailService.sendRaw(mail), recipient?.email ?? '');
    } else {
      await deliverInApp(payload, resolvedEvent);
    }
    settle(row, 'sent', null);
  } catch (err) {
    const error = err as Error;
    const permanent = error instanceof PermanentDeliveryError || error.name === 'PermanentDeliveryError';
    const message = error.message ?? 'delivery failed';
    if (permanent || row.attempts >= row.max_attempts) {
      settle(row, 'failed', `${permanent ? 'permanent-error' : 'max-attempts'}: ${message}`);
    } else {
      scheduleRetry(row, message);
    }
  }
}

type Outcome = 'sent' | 'failed' | 'cancelled';

/**
 * Closes out the outbox job and its delivery row together.
 *
 * These were two separate unguarded statements, which meant a crash in between
 * left an outbox row marked `sent` beside a delivery still `pending`, and a
 * worker whose lease had already been stolen could stamp `failed` over the new
 * owner's `sent`. Both writes now happen in one transaction, and the outbox
 * update is guarded on `status = 'processing'` — if the guard bites, we no longer
 * own the job and leave its bookkeeping entirely alone.
 */
function settle(row: OutboxRow, outcome: Outcome, error: string | null): void {
  const applied = inTransaction(() => {
    const now = nowIso();
    const updated = prepare(
      `UPDATE notification_outbox
       SET status = ?, sent_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`
    ).run(outcome, outcome === 'sent' ? now : null, error ? error.slice(0, 500) : null, now, row.id);

    if (updated.changes === 0) return false;

    prepare(
      `UPDATE reminder_deliveries SET status = ?, sent_at = ? WHERE id = ? AND status = 'pending'`
    ).run(outcome, outcome === 'sent' ? now : null, row.delivery_id);
    return true;
  });

  if (!applied) {
    log.warn(`Outbox job ${row.id} finished as '${outcome}' but was no longer owned by this worker`);
    return;
  }

  if (outcome === 'sent') {
    metrics.remindersSent += 1;
  } else if (outcome === 'failed') {
    metrics.remindersFailed += 1;
    metrics.outboxDeadLettered += 1;
    log.error(`Outbox job ${row.id} permanently failed — ${error ?? 'unknown reason'}`);
  }
}

function scheduleRetry(row: OutboxRow, errorMessage: string): void {
  const backoffMs = Math.min(600_000, 30_000 * Math.pow(2, Math.max(0, row.attempts - 1)));
  const updated = prepare(
    `UPDATE notification_outbox
     SET status = 'pending', next_retry_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  ).run(new Date(Date.now() + backoffMs).toISOString(), errorMessage.slice(0, 500), nowIso(), row.id);

  if (updated.changes === 0) {
    log.warn(`Outbox job ${row.id} retry skipped: lease no longer held by this worker`);
    return;
  }
  log.warn(
    `Outbox job ${row.id} failed (attempt ${row.attempts}/${row.max_attempts}); retry in ${Math.round(backoffMs / 1000)}s`,
    errorMessage
  );
}

/**
 * Bounded-concurrency drain over a shared queue.
 *
 * Strictly serial delivery meant one slow SMTP round-trip delayed every
 * remaining job in the batch; at ~2.4s average latency a 50-job batch outlived
 * its 120s lease and the tail was redelivered. A fixed-size pool pulling from
 * one queue also avoids the lockstep problem of `Promise.all` over slices, where
 * each slice runs only as fast as its slowest member.
 */
async function drain(jobs: OutboxRow[]): Promise<void> {
  const queue = [...jobs];
  const workerCount = Math.min(Math.max(1, config.outboxConcurrency), queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      inFlight += 1;
      try {
        await processJob(job);
      } catch (err) {
        // processJob handles delivery failures itself; this is a bug guard so a
        // single unexpected throw cannot strand the rest of the batch. The job
        // keeps its lease and the watchdog will reclaim it.
        log.error(`Unhandled error processing outbox job ${job.id}`, err as Error);
      } finally {
        inFlight -= 1;
      }
    }
  });
  await Promise.all(workers);
}

export interface OutboxQueueDepth {
  pending: number;
  processing: number;
  failed: number;
  /** Pending *and* already due — the backlog the worker actually has to chew through. */
  claimable: number;
  /**
   * Age of the oldest job that is due and still unsent. Counters tell you how
   * many reminders were lost after the fact; this tells you the queue is falling
   * behind while there is still time to do something about it.
   */
  oldestClaimableAgeSeconds: number | null;
}

/**
 * A dead-letter and backlog view for operators.
 *
 * `outboxDeadLettered` is a process-lifetime counter, so it resets on every
 * restart and says nothing about how much is stuck right now. This reads the
 * table instead.
 */
export function outboxQueueDepth(): OutboxQueueDepth {
  const now = nowIso();
  const row = queryOne<{
    pending: number;
    processing: number;
    failed: number;
    claimable: number;
    oldest_claimable_at: string | null;
  }>(
    `SELECT
       COALESCE(SUM(status = 'pending'), 0) AS pending,
       COALESCE(SUM(status = 'processing'), 0) AS processing,
       COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'pending' AND scheduled_at <= ?
                    AND (next_retry_at IS NULL OR next_retry_at <= ?)), 0) AS claimable,
       MIN(CASE WHEN status = 'pending' AND scheduled_at <= ?
                     AND (next_retry_at IS NULL OR next_retry_at <= ?)
                THEN COALESCE(next_retry_at, scheduled_at) END) AS oldest_claimable_at
     FROM notification_outbox`,
    now,
    now,
    now,
    now
  )!;

  let oldestClaimableAgeSeconds: number | null = null;
  if (row.oldest_claimable_at) {
    const at = Date.parse(row.oldest_claimable_at);
    if (Number.isFinite(at)) {
      oldestClaimableAgeSeconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
    }
  }

  return {
    pending: Number(row.pending),
    processing: Number(row.processing),
    failed: Number(row.failed),
    claimable: Number(row.claimable),
    oldestClaimableAgeSeconds
  };
}

/**
 * Runs one outbox cycle, never two at once.
 *
 * A tick that arrives while a cycle is still running is *deferred*, not dropped.
 * This loop genuinely can outlast its 30s interval — every job awaits a network
 * round trip — and dropping the tick meant the queue waited a further interval
 * exactly when it was already behind. `deferred` is a flag rather than a queue,
 * so however many ticks are missed, one catch-up cycle follows; that is
 * sufficient because `claimJobs` selects on wall-clock time and always takes the
 * oldest due work, whichever tick asked for it.
 */
export async function processOnce(): Promise<number> {
  if (running) {
    deferred = true;
    metrics.engineTicksCoalesced += 1;
    log.debug('Outbox tick arrived mid-cycle; folded into a catch-up run');
    return 0;
  }
  running = true;
  try {
    let processed = await runCycle();
    if (deferred) {
      deferred = false;
      processed += await runCycle();
    }
    return processed;
  } finally {
    running = false;
    deferred = false;
  }
}

async function runCycle(): Promise<number> {
  try {
    const jobs = claimJobs();
    if (jobs.length === 0) return 0;
    await drain(jobs);
    return jobs.length;
  } catch (err) {
    log.error('Outbox processing cycle failed', err as Error);
    return 0;
  }
}

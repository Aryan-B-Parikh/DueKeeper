import { prepare, inTransaction, queryAll, queryOne } from '../db/database';
import { uuid } from '../lib/ids';
import { nowIso, PLANNER_HORIZON_MS } from '../lib/time';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';

const log = createLogger('scheduling');

/**
 * Single source of truth for turning reminders into queued work.
 *
 * Both the background planner and the synchronous event-mutation path (create,
 * update, snooze) used to carry their own copy of this logic with different
 * grace windows, so an event created through the API and the same event picked
 * up by the planner disagreed about whether a just-passed reminder should fire.
 */

export interface PlannableReminder {
  id: string;
  offset_seconds: number;
  channel: 'email' | 'in_app';
  enabled: 0 | 1;
}

export interface PlannableEvent {
  id: string;
  user_id: string;
  due_at: string;
  status: string;
}

export function scheduledForOf(dueAtIso: string, offsetSeconds: number): string | null {
  const due = new Date(dueAtIso).getTime();
  if (!Number.isFinite(due)) return null;
  const at = due - offsetSeconds * 1000;
  // Outside this range `new Date(...).toISOString()` throws RangeError.
  if (Math.abs(at) > 8.64e15) return null;
  return new Date(at).toISOString();
}

/**
 * A reminder whose fire time slipped past while the process was down should
 * still fire, provided it slipped by no more than the grace window. Without
 * this, any restart silently swallows every reminder due during the downtime.
 */
export function isPlannable(scheduledForIso: string, now: number = Date.now()): boolean {
  const at = new Date(scheduledForIso).getTime();
  if (!Number.isFinite(at)) return false;
  return at >= now - config.plannerGraceSeconds * 1000 && at <= now + PLANNER_HORIZON_MS;
}

export interface MaterializeInput {
  reminderId: string;
  eventId: string;
  userId: string;
  scheduledFor: string;
  channel: 'email' | 'in_app';
  offsetSeconds: number;
}

/**
 * Creates the delivery row and its outbox job atomically, and repairs torn writes.
 * AUDIT C3: both inserts in one txn; "already exists" still ensures outbox row.
 * Returns true when new work was queued.
 */
export function materializeDelivery(input: MaterializeInput): boolean {
  return inTransaction(() => {
    const now = nowIso();
    const freshId = uuid();

    const inserted = prepare(
      `INSERT OR IGNORE INTO reminder_deliveries
         (id, reminder_id, event_id, user_id, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(freshId, input.reminderId, input.eventId, input.userId, input.scheduledFor, now);

    let deliveryId = freshId;
    if (inserted.changes === 0) {
      const existing = queryOne<{ id: string; status: string }>(
        'SELECT id, status FROM reminder_deliveries WHERE reminder_id = ? AND scheduled_for = ?',
        input.reminderId,
        input.scheduledFor
      );
      // Already delivered, failed out, or deliberately cancelled — leave it be.
      if (!existing || existing.status !== 'pending') return false;
      deliveryId = existing.id;
    }

    const queued = prepare(
      `INSERT OR IGNORE INTO notification_outbox
         (id, delivery_id, payload, status, attempts, max_attempts, scheduled_at,
          idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      deliveryId,
      JSON.stringify({
        deliveryId,
        eventId: input.eventId,
        userId: input.userId,
        channel: input.channel,
        offsetSeconds: input.offsetSeconds,
        scheduledFor: input.scheduledFor
      }),
      config.outboxMaxAttempts,
      input.scheduledFor,
      `reminder:${deliveryId}`,
      now,
      now
    );

    if (inserted.changes === 0 && queued.changes > 0) {
      log.warn(`Repaired delivery ${deliveryId}: outbox row was missing`);
    }
    return queued.changes > 0;
  });
}

/** Plans every enabled reminder of one event. Idempotent. */
export function planRemindersForEvent(event: PlannableEvent): number {
  if (event.status === 'done' || event.status === 'cancelled') return 0;

  const reminders = queryAll<PlannableReminder>(
    'SELECT id, offset_seconds, channel, enabled FROM reminders WHERE event_id = ? AND enabled = 1',
    event.id
  );

  const now = Date.now();
  let planned = 0;
  for (const reminder of reminders) {
    const scheduledFor = scheduledForOf(event.due_at, reminder.offset_seconds);
    if (!scheduledFor || !isPlannable(scheduledFor, now)) continue;
    if (
      materializeDelivery({
        reminderId: reminder.id,
        eventId: event.id,
        userId: event.user_id,
        scheduledFor,
        channel: reminder.channel,
        offsetSeconds: reminder.offset_seconds
      })
    ) {
      planned += 1;
    }
  }
  return planned;
}

/**
 * Cancels queued work for an event. Atomic so a crash cannot leave the outbox
 * job live while its delivery row reads `cancelled` — that combination would
 * still send the notification.
 */
export function cancelPendingWorkForEvent(eventId: string): void {
  inTransaction(() => {
    prepare(
      `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
       WHERE status IN ('pending', 'processing')
         AND delivery_id IN (SELECT id FROM reminder_deliveries WHERE event_id = ?)`
    ).run(nowIso(), eventId);
    prepare(
      `UPDATE reminder_deliveries SET status = 'cancelled' WHERE event_id = ? AND status = 'pending'`
    ).run(eventId);
  });
}

interface PendingDeliveryRow {
  delivery_id: string;
  scheduled_for: string;
  due_at: string;
  offset_seconds: number;
  enabled: 0 | 1;
  event_status: string;
}

/**
 * Cancels pending deliveries that no longer match reality: the event moved,
 * was completed or cancelled, or the reminder was disabled.
 *
 * The planner's forward query only sees reminders inside the horizon, so an
 * event pushed far into the future drops out of it entirely and would otherwise
 * keep its stale delivery — firing a reminder for a deadline that has moved.
 */
export function reconcilePendingDeliveries(): number {
  const rows = queryAll<PendingDeliveryRow>(
    `SELECT d.id AS delivery_id, d.scheduled_for, e.due_at, r.offset_seconds,
            r.enabled, e.status AS event_status
     FROM reminder_deliveries d
     JOIN reminders r ON r.id = d.reminder_id
     JOIN events e ON e.id = d.event_id
     WHERE d.status = 'pending'
     ORDER BY d.scheduled_for ASC
     LIMIT ?`,
    config.reconcileBatchLimit
  );

  const stale: string[] = [];
  for (const row of rows) {
    if (row.event_status === 'done' || row.event_status === 'cancelled' || row.enabled === 0) {
      stale.push(row.delivery_id);
      continue;
    }
    const expected = scheduledForOf(row.due_at, row.offset_seconds);
    if (expected === null || expected !== row.scheduled_for) stale.push(row.delivery_id);
  }
  if (stale.length === 0) return 0;

  const placeholders = stale.map(() => '?').join(',');
  inTransaction(() => {
    prepare(
      `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
       WHERE status = 'pending' AND delivery_id IN (${placeholders})`
    ).run(nowIso(), ...stale);
    prepare(
      `UPDATE reminder_deliveries SET status = 'cancelled'
       WHERE status = 'pending' AND id IN (${placeholders})`
    ).run(...stale);
  });

  log.debug(`Cancelled ${stale.length} stale pending delivery(ies)`);
  metrics.deliveriesReconciled += stale.length;
  return stale.length;
}

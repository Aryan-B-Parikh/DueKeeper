import { prepare, inTransaction, queryAll } from '../db/database';
import { createLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { nowIso, DUE_SOON_WINDOW_MS, PLANNER_HORIZON_MS } from '../lib/time';
import { notifyEverywhere } from './notifier';
import { config } from '../config/env';
import {
  planRemindersForEvent,
  reconcilePendingDeliveries,
  type PlannableEvent
} from './scheduling';

const log = createLogger('planner');

let timer: NodeJS.Timeout | null = null;
let running = false;
let deferred = false;

export interface PlannerCycle {
  statusesUpdated: number;
  deliveriesPlanned: number;
}

export function startPlanner(): void {
  void runOnce();
  timer = setInterval(() => void runOnce(), 60_000);
  log.info('Reminder planner started (interval=60s)');
}

export function stopPlanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Runs one planner cycle, never two at once.
 *
 * A tick that arrives while a cycle is still running is *deferred* rather than
 * dropped. Dropping was the old behaviour and it quietly degraded cadence: the
 * work waited for the next interval instead, so one slow cycle turned a 60s
 * planner into a 120s one with nothing but a debug line to say so.
 *
 * `deferred` is a flag, not a queue, so any number of missed ticks collapse into
 * a single catch-up cycle. That is enough, because every query here is driven by
 * wall-clock time rather than by the tick that noticed the work — a cycle picks
 * up everything currently due regardless of how many ticks were missed.
 */
export async function runOnce(): Promise<PlannerCycle> {
  if (running) {
    deferred = true;
    metrics.engineTicksCoalesced += 1;
    log.debug('Planner tick arrived mid-cycle; folded into a catch-up run');
    return { statusesUpdated: 0, deliveriesPlanned: 0 };
  }
  running = true;
  try {
    const first = await runCycle();
    if (!deferred) return first;
    deferred = false;
    const catchUp = await runCycle();
    return {
      statusesUpdated: first.statusesUpdated + catchUp.statusesUpdated,
      deliveriesPlanned: first.deliveriesPlanned + catchUp.deliveriesPlanned
    };
  } finally {
    running = false;
    deferred = false;
  }
}

async function runCycle(): Promise<PlannerCycle> {
  try {
    const statusesUpdated = recomputeStatuses();
    const deliveriesPlanned = planDeliveries();
    reconcilePendingDeliveries();
    return { statusesUpdated, deliveriesPlanned };
  } catch (err) {
    log.error('Planner cycle failed', err as Error);
    return { statusesUpdated: 0, deliveriesPlanned: 0 };
  }
}

function recomputeStatuses(): number {
  const result = prepare(
    `UPDATE events
     SET status = CASE
       WHEN due_at < ? THEN 'overdue'
       WHEN due_at <= ? THEN 'due_soon'
       ELSE 'upcoming'
     END
     WHERE status NOT IN ('done', 'cancelled')
       AND status != CASE
         WHEN due_at < ? THEN 'overdue'
         WHEN due_at <= ? THEN 'due_soon'
         ELSE 'upcoming'
       END`
  ).run(
    nowIso(),
    new Date(Date.now() + DUE_SOON_WINDOW_MS).toISOString(),
    nowIso(),
    new Date(Date.now() + DUE_SOON_WINDOW_MS).toISOString()
  );
  if (result.changes > 0) {
    log.debug(`Recomputed ${result.changes} event status(es)`);
  }
  notifyDueSoonEvents();
  return Number(result.changes);
}

interface DueSoonRow {
  id: string;
  user_id: string;
  title: string;
  due_at: string;
  notification_prefs: string;
}

function notifyDueSoonEvents(): void {
  const rows = queryAll<DueSoonRow>(
    `SELECT e.id, e.user_id, e.title, e.due_at, u.notification_prefs
     FROM events e
     JOIN users u ON u.id = e.user_id
     WHERE e.status = 'due_soon'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.idempotency_key = 'due_soon:' || e.id
       )
     LIMIT 50`
  );

  for (const row of rows) {
    let prefs: Record<string, boolean> = {};
    try {
      prefs = JSON.parse(row.notification_prefs) as Record<string, boolean>;
    } catch {
      prefs = {};
    }
    if (prefs.dueSoonAlerts === false) continue;

    notifyEverywhere(
      row.user_id,
      'warning',
      `Due soon: ${row.title}`,
      `"${row.title}" is due within 72 hours (${formatOffsetToGo(row.due_at)}).`,
      { eventId: row.id, idempotencyKey: `due_soon:${row.id}` }
    );
  }
}

function formatOffsetToGo(dueIso: string): string {
  const hours = Math.max(0, Math.round((new Date(dueIso).getTime() - Date.now()) / 3_600_000));
  if (hours < 1) return 'less than an hour from now';
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

interface PlanRow {
  event_id: string;
  user_id: string;
  due_at: string;
  status: string;
}

function planDeliveries(): number {
  const horizonEnd = new Date(Date.now() + PLANNER_HORIZON_MS).toISOString();

  // AUDIT C3: batch by distinct event with LIMIT (was row-per-reminder, no LIMIT).
  const rows = queryAll<PlanRow>(
    `SELECT DISTINCT e.id AS event_id, e.user_id, e.due_at, e.status
     FROM reminders r
     JOIN events e ON e.id = r.event_id
     WHERE r.enabled = 1
       AND e.status NOT IN ('done','cancelled')
       AND datetime(e.due_at) > datetime('now', printf('-%d seconds', ?))
       AND datetime(e.due_at, printf('-%d seconds', r.offset_seconds)) <= datetime(?)
     ORDER BY e.due_at ASC
     LIMIT ?`,
    config.plannerGraceSeconds,
    horizonEnd,
    config.plannerBatchLimit
  );

  let planned = 0;
  for (const row of rows) {
    const event: PlannableEvent = {
      id: row.event_id,
      user_id: row.user_id,
      due_at: row.due_at,
      status: row.status
    };
    try {
      planned += planRemindersForEvent(event);
    } catch (err) {
      // One bad event must not abort the whole cycle.
      log.error(`Failed to plan reminders for event ${row.event_id}`, err as Error);
    }
  }

  cancelDeliveriesForTerminalEvents();

  if (planned > 0) log.info(`Planned ${planned} new reminder delivery(ies)`);
  return planned;
}

function cancelDeliveriesForTerminalEvents(): void {
  inTransaction(() => {
    prepare(
      `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
       WHERE status = 'pending'
         AND delivery_id IN (
           SELECT d.id FROM reminder_deliveries d
           JOIN events e ON e.id = d.event_id
           WHERE e.status IN ('done','cancelled')
         )`
    ).run(nowIso());
    prepare(
      `UPDATE reminder_deliveries SET status = 'cancelled'
       WHERE status = 'pending'
         AND event_id IN (SELECT id FROM events WHERE status IN ('done','cancelled'))`
    ).run();
  });
}

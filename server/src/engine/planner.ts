import { prepare } from '../db/database';
import { createLogger } from '../lib/logger';
import { nowIso, DUE_SOON_WINDOW_MS, PLANNER_HORIZON_MS } from '../lib/time';
import { uuid } from '../lib/ids';
import { notifyEverywhere } from './notifier';

const log = createLogger('planner');

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPlanner(): void {
  void runOnce();
  timer = setInterval(() => void runOnce(), 60_000);
  log.info('Reminder planner started (interval=60s)');
}

export function stopPlanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runOnce(): Promise<{ statusesUpdated: number; deliveriesPlanned: number }> {
  if (running) return { statusesUpdated: 0, deliveriesPlanned: 0 };
  running = true;
  try {
    const statusesUpdated = recomputeStatuses();
    const deliveriesPlanned = planDeliveries();
    return { statusesUpdated, deliveriesPlanned };
  } catch (err) {
    log.error('Planner cycle failed', err as Error);
    return { statusesUpdated: 0, deliveriesPlanned: 0 };
  } finally {
    running = false;
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
  const rows = prepare(
    `SELECT e.id, e.user_id, e.title, e.due_at, u.notification_prefs
     FROM events e
     JOIN users u ON u.id = e.user_id
     WHERE e.status = 'due_soon'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.idempotency_key = 'due_soon:' || e.id
       )
     LIMIT 50`
  ).all() as unknown as DueSoonRow[];

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
  reminder_id: string;
  event_id: string;
  user_id: string;
  offset_seconds: number;
  channel: 'email' | 'in_app';
  due_at: string;
}

function planDeliveries(): number {
  const horizonEnd = new Date(Date.now() + PLANNER_HORIZON_MS).toISOString();
  const rows = prepare(
    `SELECT r.id AS reminder_id, r.event_id, r.offset_seconds, r.channel,
            e.id AS event_id, e.user_id, e.due_at
     FROM reminders r
     JOIN events e ON e.id = r.event_id
     WHERE r.enabled = 1
       AND e.status NOT IN ('done','cancelled')
       AND datetime(e.due_at) > datetime('now')
       AND datetime(e.due_at, printf('-%d seconds', r.offset_seconds)) <= datetime(?)`
  ).all(horizonEnd) as unknown as PlanRow[];

  let planned = 0;
  for (const row of rows) {
    const scheduledMs = new Date(row.due_at).getTime() - row.offset_seconds * 1000;
    if (scheduledMs <= Date.now()) continue;
    const scheduledFor = new Date(scheduledMs).toISOString();

    const deliveryId = uuid();
    const inserted = prepare(
      `INSERT OR IGNORE INTO reminder_deliveries
         (id, reminder_id, event_id, user_id, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(deliveryId, row.reminder_id, row.event_id, row.user_id, scheduledFor, nowIso());

    if (inserted.changes === 0) continue;

    prepare(
      `INSERT OR IGNORE INTO notification_outbox
         (id, delivery_id, payload, status, attempts, max_attempts, scheduled_at, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, 3, ?, ?, ?, ?)`
    ).run(
      uuid(),
      deliveryId,
      JSON.stringify({
        deliveryId,
        eventId: row.event_id,
        userId: row.user_id,
        channel: row.channel,
        offsetSeconds: row.offset_seconds,
        scheduledFor
      }),
      scheduledFor,
      `reminder:${deliveryId}`,
      nowIso(),
      nowIso()
    );
    planned += 1;
  }

  cancelDeliveriesForTerminalEvents();

  if (planned > 0) log.info(`Planned ${planned} new reminder delivery(ies)`);
  return planned;
}

function cancelDeliveriesForTerminalEvents(): void {
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
}

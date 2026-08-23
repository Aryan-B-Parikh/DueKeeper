import { prepare } from '../../db/database';
import { uuid } from '../../lib/ids';
import { nowIso, computeStatus, addSeconds, PLANNER_HORIZON_MS, type EventStatus } from '../../lib/time';

export interface ReminderRow {
  id: string;
  event_id: string;
  offset_seconds: number;
  channel: 'email' | 'in_app';
  enabled: 0 | 1;
}

export interface EventRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  event_type: 'exam' | 'submission' | 'hackathon' | 'other';
  due_at: string;
  timezone: string;
  source: 'manual' | 'ai_text' | 'ai_screenshot' | 'email' | 'calendar' | 'ics_import';
  ai_confidence: number | null;
  confirmation_status: 'auto_saved' | 'user_confirmed' | null;
  status: string;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  offsetSeconds: number;
  channel: 'email' | 'in_app';
}

export interface EventInput {
  title: string;
  description?: string | null;
  eventType: 'exam' | 'submission' | 'hackathon' | 'other';
  dueAt: string;
  timezone: string;
  reminders?: ReminderInput[];
  source?: EventRow['source'];
  aiConfidence?: number | null;
  confirmationStatus?: 'auto_saved' | 'user_confirmed' | null;
}

export interface ReminderResponse {
  id: string;
  offsetSeconds: number;
  channel: 'email' | 'in_app';
  enabled: boolean;
}

export interface EventResponse {
  id: string;
  title: string;
  description: string | null;
  eventType: string;
  dueAt: string;
  timezone: string;
  source: string;
  aiConfidence: number | null;
  confirmationStatus: string | null;
  status: EventStatus;
  doneAt: string | null;
  reminders: ReminderResponse[];
  createdAt: string;
  updatedAt: string;
}

export function mapEvent(row: EventRow, reminders: ReminderRow[]): EventResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    eventType: row.event_type,
    dueAt: row.due_at,
    timezone: row.timezone,
    source: row.source,
    aiConfidence: row.ai_confidence,
    confirmationStatus: row.confirmation_status,
    status: computeStatus(row.due_at, row.status),
    doneAt: row.done_at,
    reminders: reminders.map((r) => ({
      id: r.id,
      offsetSeconds: r.offset_seconds,
      channel: r.channel,
      enabled: r.enabled === 1
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadReminders(eventIds: string[]): Map<string, ReminderRow[]> {
  const map = new Map<string, ReminderRow[]>();
  if (eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = prepare(
    `SELECT * FROM reminders WHERE event_id IN (${placeholders}) ORDER BY offset_seconds ASC`
  ).all(...eventIds) as unknown as ReminderRow[];
  for (const row of rows) {
    const list = map.get(row.event_id) ?? [];
    list.push(row);
    map.set(row.event_id, list);
  }
  return map;
}

export function getEventRow(userId: string, eventId: string): EventRow | undefined {
  return prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(
    eventId,
    userId
  ) as EventRow | undefined;
}

export function getEventWithReminders(
  userId: string,
  eventId: string
): EventResponse | undefined {
  const row = getEventRow(userId, eventId);
  if (!row) return undefined;
  const reminders = prepare('SELECT * FROM reminders WHERE event_id = ? ORDER BY offset_seconds').all(
    eventId
  ) as unknown as ReminderRow[];
  return mapEvent(row, reminders);
}

export function listEvents(
  userId: string,
  filter?: { status?: string }
): EventResponse[] {
  let rows: EventRow[];
  const activeCondition = `status NOT IN ('done','cancelled')`;
  if (!filter?.status || filter.status === 'all') {
    rows = prepare(
      `SELECT * FROM events WHERE user_id = ? ORDER BY due_at ASC LIMIT 500`
    ).all(userId) as unknown as EventRow[];
  } else if (filter.status === 'active') {
    rows = prepare(
      `SELECT * FROM events WHERE user_id = ? AND ${activeCondition} ORDER BY due_at ASC LIMIT 500`
    ).all(userId) as unknown as EventRow[];
  } else if (['upcoming', 'due_soon', 'overdue', 'done', 'cancelled'].includes(filter.status)) {
    if (filter.status === 'done' || filter.status === 'cancelled') {
      rows = prepare(
        'SELECT * FROM events WHERE user_id = ? AND status = ? ORDER BY due_at ASC LIMIT 500'
      ).all(userId, filter.status) as unknown as EventRow[];
    } else {
      const all = prepare(
        `SELECT * FROM events WHERE user_id = ? AND ${activeCondition} ORDER BY due_at ASC LIMIT 500`
      ).all(userId) as unknown as EventRow[];
      rows = all.filter((row) => computeStatus(row.due_at, row.status) === filter.status);
    }
  } else {
    throw new Error(`Unknown status filter: ${filter.status}`);
  }

  const remindersByEvent = loadReminders(rows.map((r) => r.id));
  return rows.map((row) => mapEvent(row, remindersByEvent.get(row.id) ?? []));
}

function replaceReminders(eventId: string, reminders: ReminderInput[]): void {
  prepare('DELETE FROM reminders WHERE event_id = ?').run(eventId);
  const seen = new Set<string>();
  for (const reminder of reminders) {
    const key = `${reminder.offsetSeconds}:${reminder.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prepare(
      `INSERT INTO reminders (id, event_id, offset_seconds, channel, enabled, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).run(uuid(), eventId, reminder.offsetSeconds, reminder.channel, nowIso());
  }
}

export function cancelPendingWork(eventId: string): void {
  prepare(
    `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
     WHERE status = 'pending'
       AND delivery_id IN (SELECT id FROM reminder_deliveries WHERE event_id = ?)`
  ).run(nowIso(), eventId);
  prepare(
    `UPDATE reminder_deliveries SET status = 'cancelled' WHERE event_id = ? AND status = 'pending'`
  ).run(eventId);
}

export function planDeliveriesForEvent(row: EventRow): number {
  if (row.status === 'done' || row.status === 'cancelled') return 0;
  const dueMs = new Date(row.due_at).getTime();
  const now = Date.now();
  const reminders = prepare('SELECT * FROM reminders WHERE event_id = ? AND enabled = 1').all(
    row.id
  ) as unknown as ReminderRow[];

  let planned = 0;
  for (const reminder of reminders) {
    const scheduledFor = new Date(dueMs - reminder.offset_seconds * 1000).toISOString();
    const scheduledMs = new Date(scheduledFor).getTime();
    if (scheduledMs < now - 60_000 || scheduledMs > now + PLANNER_HORIZON_MS) continue;

    const deliveryId = uuid();
    const result = prepare(
      `INSERT OR IGNORE INTO reminder_deliveries (id, reminder_id, event_id, user_id, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(deliveryId, reminder.id, row.id, row.user_id, scheduledFor, nowIso());

    if (result.changes > 0) {
      planned += 1;
      enqueueOutbox({
        deliveryId,
        eventId: row.id,
        userId: row.user_id,
        scheduledFor,
        channel: reminder.channel,
        offsetSeconds: reminder.offset_seconds
      });
    }
  }
  return planned;
}

interface OutboxEnqueueInput {
  deliveryId: string;
  eventId: string;
  userId: string;
  scheduledFor: string;
  channel: 'email' | 'in_app';
  offsetSeconds: number;
}

export function enqueueOutbox(input: OutboxEnqueueInput): void {
  const now = nowIso();
  prepare(
    `INSERT OR IGNORE INTO notification_outbox
       (id, delivery_id, payload, status, attempts, max_attempts, scheduled_at, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, 3, ?, ?, ?, ?)`
  ).run(
    uuid(),
    input.deliveryId,
    JSON.stringify({
      deliveryId: input.deliveryId,
      eventId: input.eventId,
      userId: input.userId,
      channel: input.channel,
      offsetSeconds: input.offsetSeconds,
      scheduledFor: input.scheduledFor
    }),
    input.scheduledFor,
    `reminder:${input.deliveryId}`,
    now,
    now
  );
}

export function createEvent(userId: string, input: EventInput): EventResponse {
  const id = uuid();
  const now = nowIso();
  prepare(
    `INSERT INTO events
       (id, user_id, title, description, event_type, due_at, timezone, source, ai_confidence, confirmation_status, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?)`
  ).run(
    id,
    userId,
    input.title.trim(),
    input.description?.trim() ?? null,
    input.eventType,
    new Date(input.dueAt).toISOString(),
    input.timezone,
    input.source ?? 'manual',
    input.aiConfidence ?? null,
    input.confirmationStatus ?? null,
    now,
    now
  );

  replaceReminders(id, input.reminders ?? []);
  const row = getEventRow(userId, id)!;
  planDeliveriesForEvent(row);
  return getEventWithReminders(userId, id)!;
}

export function updateEvent(userId: string, eventId: string, input: EventInput): EventResponse | undefined {
  const existing = getEventRow(userId, eventId);
  if (!existing) return undefined;

  prepare(
    `UPDATE events
     SET title = ?, description = ?, event_type = ?, due_at = ?, timezone = ?, source = ?, status = 'upcoming', done_at = NULL, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    input.title.trim(),
    input.description?.trim() ?? null,
    input.eventType,
    new Date(input.dueAt).toISOString(),
    input.timezone,
    existing.source,
    nowIso(),
    eventId,
    userId
  );

  cancelPendingWork(eventId);
  replaceReminders(eventId, input.reminders ?? []);
  const row = getEventRow(userId, eventId)!;
  planDeliveriesForEvent(row);
  return getEventWithReminders(userId, eventId);
}

export function deleteEvent(userId: string, eventId: string): boolean {
  const result = prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(eventId, userId);
  return result.changes > 0;
}

export function setEventDone(userId: string, eventId: string): EventResponse | undefined {
  const existing = getEventRow(userId, eventId);
  if (!existing) return undefined;
  prepare(
    `UPDATE events SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?`
  ).run(nowIso(), nowIso(), eventId);
  cancelPendingWork(eventId);
  return getEventWithReminders(userId, eventId);
}

export function cancelEvent(userId: string, eventId: string): EventResponse | undefined {
  const existing = getEventRow(userId, eventId);
  if (!existing) return undefined;
  prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
    nowIso(),
    eventId
  );
  cancelPendingWork(eventId);
  return getEventWithReminders(userId, eventId);
}

const SNOOZE_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400 };

export function snoozeEvent(
  userId: string,
  eventId: string,
  duration: string
): EventResponse | undefined {
  const existing = getEventRow(userId, eventId);
  if (!existing) return undefined;
  const match = /^(\d+)([mhd])$/.exec(duration.trim().toLowerCase());
  if (!match) throw new Error('Duration must look like 30m, 2h or 1d');

  const seconds = Number(match[1]) * SNOOZE_SECONDS[match[2]];
  const currentDue = new Date(existing.due_at).getTime();
  let base = currentDue;
  if (currentDue <= Date.now()) {
    base = Date.now();
  }
  const newDue = new Date(Math.max(base + seconds * 1000, Date.now() + 60_000)).toISOString();

  prepare(`UPDATE events SET due_at = ?, status = 'upcoming', done_at = NULL, updated_at = ? WHERE id = ?`).run(
    newDue,
    nowIso(),
    eventId
  );

  cancelPendingWork(eventId);
  const row = getEventRow(userId, eventId)!;
  planDeliveriesForEvent(row);
  return getEventWithReminders(userId, eventId);
}

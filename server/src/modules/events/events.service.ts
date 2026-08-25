import { prepare, inTransaction, queryAll, queryOne } from '../../db/database';
import { uuid } from '../../lib/ids';
import { nowIso, computeStatus, DUE_SOON_WINDOW_MS, type EventStatus } from '../../lib/time';
import { config } from '../../config/env';
import { ValidationError } from '../../lib/errors';
import { isValidTimezone, validateInstant, toUtcIso } from '../../lib/datetimeValidation';
import type { Paged } from '../../lib/pagination';
import { planRemindersForEvent, cancelPendingWorkForEvent } from '../../engine/scheduling';

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

/**
 * Normalizes an instant to canonical UTC ISO, rejecting anything the HTTP layer
 * would have rejected.
 *
 * The zod schemas already enforce an offset-bearing, real-calendar instant, but
 * the service is also called directly by the inbox webhook, the ICS importer and
 * the Google sync, none of which pass through zod. This used to be a bare
 * `new Date(x)` check, which let two classes of bad data in behind zod's back: a
 * naive `2026-03-14T09:00:00` (silently read in the server's own zone — the H5
 * failure) and an impossible civil date like `2026-02-31T09:00:00Z` (rolled
 * forward to March 3rd by `Date.parse` rather than refused). Delegating to
 * `validateInstant` means there is exactly one definition of an acceptable
 * instant, wherever a deadline enters the system.
 */
function normalizeInstant(value: string, field = 'dueAt'): string {
  const problem = validateInstant(value);
  if (problem) {
    // validateInstant phrases its messages for the `dueAt` field; other callers
    // pass their own field name.
    throw new ValidationError(problem.message.replace(/^dueAt/, field), { [field]: problem.code });
  }
  return toUtcIso(value);
}

function normalizeTimezone(value: string): string {
  const tz = value.trim();
  if (!isValidTimezone(tz)) throw new ValidationError('timezone must be an IANA identifier');
  return tz;
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
  const rows = queryAll<ReminderRow>(
    `SELECT * FROM reminders WHERE event_id IN (${placeholders}) ORDER BY offset_seconds ASC`,
    ...eventIds
  );
  for (const row of rows) {
    const list = map.get(row.event_id) ?? [];
    list.push(row);
    map.set(row.event_id, list);
  }
  return map;
}

export function getEventRow(userId: string, eventId: string): EventRow | undefined {
  return queryOne<EventRow>('SELECT * FROM events WHERE id = ? AND user_id = ?', eventId, userId);
}

export function getEventWithReminders(
  userId: string,
  eventId: string
): EventResponse | undefined {
  const row = getEventRow(userId, eventId);
  if (!row) return undefined;
  const reminders = queryAll<ReminderRow>('SELECT * FROM reminders WHERE event_id = ? ORDER BY offset_seconds', eventId);
  return mapEvent(row, reminders);
}

export const EVENT_STATUS_FILTERS = [
  'all',
  'active',
  'upcoming',
  'due_soon',
  'overdue',
  'done',
  'cancelled'
] as const;

export type EventStatusFilter = (typeof EVENT_STATUS_FILTERS)[number];

export function isEventStatusFilter(value: string): value is EventStatusFilter {
  return (EVENT_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * Builds the WHERE fragment for a status filter.
 *
 * The page query and the count query are both derived from this one string, so
 * they cannot drift — a total computed under different conditions than the rows
 * is worse than no total at all, because `hasMore` then lies.
 *
 * The due-soon window comes from the same constant `computeStatus` uses, so the
 * SQL filter and the status reported in each row always agree.
 */
function statusPredicate(filter: EventStatusFilter): string {
  const activeCondition = `status NOT IN ('done','cancelled')`;
  const windowHours = DUE_SOON_WINDOW_MS / 3_600_000;
  switch (filter) {
    case 'all':
      return '1 = 1';
    case 'active':
      return activeCondition;
    case 'done':
      return `status = 'done'`;
    case 'cancelled':
      return `status = 'cancelled'`;
    case 'upcoming':
      return `${activeCondition} AND datetime(due_at) > datetime('now', '+${windowHours} hours')`;
    case 'due_soon':
      return `${activeCondition} AND datetime(due_at) <= datetime('now', '+${windowHours} hours') AND datetime(due_at) >= datetime('now')`;
    case 'overdue':
      return `${activeCondition} AND datetime(due_at) < datetime('now')`;
  }
}

export function countEvents(userId: string, status: EventStatusFilter = 'all'): number {
  const row = queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM events WHERE user_id = ? AND ${statusPredicate(status)}`, userId)!;
  return Number(row.c);
}

/**
 * Returns one page of events plus the total matching the same filter.
 *
 * Status filtering happens in SQL. It used to be applied in memory *after* a
 * hardcoded `LIMIT 500`, so `?status=overdue` on an account with more than 500
 * events returned an arbitrary subset with no indication rows were missing.
 */
export function listEvents(
  userId: string,
  filter: { status?: string; limit: number; offset: number }
): Paged<EventResponse> {
  const status = filter.status ?? 'all';
  if (!isEventStatusFilter(status)) {
    throw new ValidationError(`Unknown status filter: ${status}`);
  }
  const limit = Math.min(Math.max(1, filter.limit), config.maxListPageSize);
  const offset = Math.max(0, filter.offset);
  const predicate = statusPredicate(status);

  const rows = queryAll<EventRow>(
    `SELECT * FROM events WHERE user_id = ? AND ${predicate} ORDER BY due_at ASC, id ASC LIMIT ? OFFSET ?`,
    userId,
    limit,
    offset
  );

  const remindersByEvent = loadReminders(rows.map((r) => r.id));
  return {
    items: rows.map((row) => mapEvent(row, remindersByEvent.get(row.id) ?? [])),
    total: countEvents(userId, status)
  };
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

/**
 * Cancels queued work for an event.
 *
 * Delegates to the engine so that the API path and the background planner agree
 * on what "cancelled" means. The local copy this replaced only cancelled outbox
 * rows in `pending`, leaving a row already claimed by a worker (`processing`)
 * free to deliver a reminder for an event the user had just completed.
 */
export function cancelPendingWork(eventId: string): void {
  cancelPendingWorkForEvent(eventId);
}

/**
 * Plans deliveries for one event.
 *
 * This used to be a second, subtly different implementation of the planner's
 * logic — it hardcoded `max_attempts = 3` instead of reading the configured
 * value, skipped the torn-write repair, and computed its own grace window. All
 * of it now routes through the shared scheduler.
 */
export function planDeliveriesForEvent(row: EventRow): number {
  return planRemindersForEvent({
    id: row.id,
    user_id: row.user_id,
    due_at: row.due_at,
    status: row.status
  });
}

export function createEvent(userId: string, input: EventInput): EventResponse {
  const id = uuid();
  const now = nowIso();
  const dueAt = normalizeInstant(input.dueAt);
  const timezone = normalizeTimezone(input.timezone);
  // One transaction: an event without its reminders is a deadline that silently
  // never fires, which is worse than a failed create the caller can retry.
  return inTransaction(() => {
    prepare(
      `INSERT INTO events
         (id, user_id, title, description, event_type, due_at, timezone, source, ai_confidence, confirmation_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      input.title.trim(),
      input.description?.trim() ?? null,
      input.eventType,
      dueAt,
      timezone,
      input.source ?? 'manual',
      input.aiConfidence ?? null,
      input.confirmationStatus ?? null,
      // Was hardcoded 'upcoming', so importing an already-past deadline showed as
      // upcoming until something else recomputed it.
      computeStatus(dueAt, 'upcoming'),
      now,
      now
    );

    replaceReminders(id, input.reminders ?? []);
    const row = getEventRow(userId, id)!;
    planDeliveriesForEvent(row);
    return getEventWithReminders(userId, id)!;
  });
}

export function updateEvent(userId: string, eventId: string, input: EventInput): EventResponse | undefined {
  const dueAt = normalizeInstant(input.dueAt);
  const timezone = normalizeTimezone(input.timezone);

  return inTransaction(() => {
    const existing = getEventRow(userId, eventId);
    if (!existing) return undefined;

    // Editing a completed event used to silently resurrect it: the update forced
    // `status = 'upcoming', done_at = NULL`, so fixing a typo in a finished
    // deadline's title started sending its reminders again. Terminal states are
    // now preserved and only changed through setEventDone / cancelEvent.
    const isTerminal = existing.status === 'done' || existing.status === 'cancelled';
    const nextStatus = isTerminal ? existing.status : computeStatus(dueAt, 'upcoming');

    prepare(
      `UPDATE events
       SET title = ?, description = ?, event_type = ?, due_at = ?, timezone = ?, source = ?,
           status = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      input.title.trim(),
      input.description?.trim() ?? null,
      input.eventType,
      dueAt,
      timezone,
      existing.source,
      nextStatus,
      nowIso(),
      eventId,
      userId
    );

    cancelPendingWork(eventId);
    replaceReminders(eventId, input.reminders ?? []);
    const row = getEventRow(userId, eventId)!;
    // A terminal event stays terminal, so there is nothing to re-arm; planning
    // anyway would queue reminders for a deadline the user already closed.
    if (!isTerminal) planDeliveriesForEvent(row);
    return getEventWithReminders(userId, eventId);
  });
}

/**
 * Updates an event that is mirrored from an external calendar.
 *
 * External syncs used to write `due_at` with a bare UPDATE, which left the
 * event's status stale and — worse — left the already-queued reminders pointing
 * at the old date, so a rescheduled deadline reminded on the wrong day. This
 * recomputes status and re-plans deliveries while preserving the reminder
 * offsets the user configured.
 */
export function rescheduleExternalEvent(
  userId: string,
  eventId: string,
  input: { title: string; dueAt: string; description: string | null }
): boolean {
  const dueAt = normalizeInstant(input.dueAt);
  return inTransaction(() => {
    const existing = getEventRow(userId, eventId);
    if (!existing) return false;
    const isTerminal = existing.status === 'done' || existing.status === 'cancelled';
    const unchanged =
      existing.due_at === dueAt &&
      existing.title === input.title &&
      existing.description === input.description;
    if (unchanged) return false;

    prepare(
      `UPDATE events SET title = ?, due_at = ?, description = ?, status = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      input.title,
      dueAt,
      input.description,
      isTerminal ? existing.status : computeStatus(dueAt, 'upcoming'),
      nowIso(),
      eventId,
      userId
    );

    if (existing.due_at !== dueAt && !isTerminal) {
      cancelPendingWork(eventId);
      planDeliveriesForEvent(getEventRow(userId, eventId)!);
    }
    return true;
  });
}

export function deleteEvent(userId: string, eventId: string): boolean {
  return inTransaction(() => {
    // Ownership is checked first: cancelling work for an event belonging to
    // someone else would otherwise be a cross-user write, even though the DELETE
    // itself is correctly scoped.
    if (!getEventRow(userId, eventId)) return false;
    // Cancel pending outbox work before deleting so no orphaned notification fires.
    cancelPendingWork(eventId);
    const result = prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(eventId, userId);
    return result.changes > 0;
  });
}

export function setEventDone(userId: string, eventId: string): EventResponse | undefined {
  return inTransaction(() => {
    const existing = getEventRow(userId, eventId);
    if (!existing) return undefined;
    prepare(
      `UPDATE events SET status = 'done', done_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(nowIso(), nowIso(), eventId, userId);
    cancelPendingWork(eventId);
    return getEventWithReminders(userId, eventId);
  });
}

export function cancelEvent(userId: string, eventId: string): EventResponse | undefined {
  return inTransaction(() => {
    const existing = getEventRow(userId, eventId);
    if (!existing) return undefined;
    prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ?`).run(
      nowIso(),
      eventId,
      userId
    );
    cancelPendingWork(eventId);
    return getEventWithReminders(userId, eventId);
  });
}

const SNOOZE_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400 };
const MAX_SNOOZE_SECONDS = 30 * 86400;

export function snoozeEvent(
  userId: string,
  eventId: string,
  duration: string
): EventResponse | undefined {
  const match = /^(\d+)([mhd])$/.exec(duration.trim().toLowerCase());
  if (!match) throw new ValidationError('duration must look like 30m, 2h or 1d');

  const unit = SNOOZE_SECONDS[match[2]];
  const seconds = Number(match[1]) * unit;
  // Bounded here as well as at the route (H6): the route is not the only caller,
  // and an unbounded value reaches `new Date().toISOString()`, which throws
  // RangeError past 8.64e15 ms and surfaces as a 500.
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SNOOZE_SECONDS) {
    throw new ValidationError('duration must be a positive value of at most 30 days');
  }

  // The read has to be inside the transaction: reading the current due date
  // outside it means two concurrent snoozes both compute from the same base and
  // the second silently discards the first.
  return inTransaction(() => {
    const existing = getEventRow(userId, eventId);
    if (!existing) return undefined;
    // Snoozing a finished deadline used to force `status = 'upcoming',
    // done_at = NULL`, quietly resurrecting it and re-arming its reminders.
    if (existing.status === 'done' || existing.status === 'cancelled') {
      throw new ValidationError(`Cannot snooze a deadline that is already ${existing.status}`);
    }

    const currentDue = new Date(existing.due_at).getTime();
    // Snoozing an overdue deadline moves it forward from now, not from the date
    // it already blew past — otherwise "+1h" on a week-old item is still overdue.
    let base = Number.isFinite(currentDue) ? currentDue : Date.now();
    if (base <= Date.now()) base = Date.now();

    const newMs = base + seconds * 1000;
    if (!Number.isFinite(newMs) || Math.abs(newMs) > 8.64e15) {
      throw new ValidationError('Snoozed time is out of range');
    }
    // Keep at least a minute of runway so the planner has something to schedule.
    const newDue = new Date(Math.max(newMs, Date.now() + 60_000)).toISOString();

    prepare(
      `UPDATE events SET due_at = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(newDue, computeStatus(newDue, 'upcoming'), nowIso(), eventId, userId);

    cancelPendingWork(eventId);
    const row = getEventRow(userId, eventId)!;
    planDeliveriesForEvent(row);
    return getEventWithReminders(userId, eventId);
  });
}

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { handler, parseWith } from '../../middleware/validate';
import {
  listEvents,
  getEventWithReminders,
  createEvent,
  updateEvent,
  deleteEvent,
  setEventDone,
  cancelEvent,
  snoozeEvent,
  isEventStatusFilter,
  EVENT_STATUS_FILTERS
} from './events.service';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { instantSchema, timezoneSchema } from '../../lib/datetimeValidation';
import { parsePageRequest, pageMeta } from '../../lib/pagination';
import { config } from '../../config/env';

export const eventsRouter = Router();

eventsRouter.use(requireAuth());

const reminderSchema = z.object({
  offsetSeconds: z
    .number()
    .int()
    .min(0)
    .max(604800, 'Reminder offset cannot exceed 7 days'),
  channel: z.enum(['email', 'in_app'])
});

const eventSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(2000).nullish(),
  eventType: z.enum(['exam', 'submission', 'hackathon', 'other']),
  // Both fields are strict on purpose (H5): the instant must carry its own
  // offset so it cannot be reinterpreted in the server's zone, and the timezone
  // must be a real IANA id because that is what the reminder planner and the
  // "local date" grouping read. A naive `dueAt` used to be accepted here and
  // silently parsed as server-local, which for a deadline product means the
  // reminder fires hours off.
  dueAt: instantSchema,
  timezone: timezoneSchema,
  reminders: z.array(reminderSchema).max(10).optional()
});

function parseSnoozeDuration(input: unknown): string {
  const value = typeof input === 'string' ? input : '';
  const normalized = value.trim().toLowerCase();
  // Digits are bounded in the pattern itself, so `seconds` below cannot reach a
  // magnitude where the arithmetic stops being exact.
  const match = /^(\d{1,7})([mhd])$/.exec(normalized);
  if (!match) {
    throw new ValidationError('duration must be a positive value like 30m, 2h or 1d');
  }
  const num = Number(match[1]);
  const seconds = num * (match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 86400);
  // Catches `0m` and its zero-padded spellings (`00m`, `000d`) in one check
  // instead of comparing against a hand-written list of them.
  if (seconds <= 0) {
    throw new ValidationError('duration must be a positive value like 30m, 2h or 1d');
  }
  // Cap to 30 days to avoid Date range overflow (H6) and absurd snoozes.
  if (seconds > 30 * 86400) {
    throw new ValidationError('duration must not exceed 30 days');
  }
  return normalized;
}

eventsRouter.get(
  '/',
  handler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status !== undefined && !isEventStatusFilter(status)) {
      throw new ValidationError(
        `Unknown status filter: ${status}. Expected one of ${EVENT_STATUS_FILTERS.join(', ')}`
      );
    }
    const page = parsePageRequest(req.query as Record<string, unknown>, {
      defaultLimit: 50,
      maxLimit: config.maxListPageSize
    });
    const result = listEvents(req.user!.id, { status, ...page });
    // `events` keeps its name so existing clients keep working; `page` is what
    // makes it possible to tell a short page from the end of the list. Without a
    // total, a client had no way to know the previous hardcoded cap had silently
    // truncated its results.
    res.json({ events: result.items, page: pageMeta(page, result.total) });
  })
);

eventsRouter.get(
  '/:id',
  handler(async (req, res) => {
    const event = getEventWithReminders(req.user!.id, req.params.id);
    if (!event) throw new NotFoundError('Event');
    res.json({ event });
  })
);

eventsRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseWith(eventSchema, req.body);
    const event = createEvent(req.user!.id, body);
    res.status(201).json({ event });
  })
);

eventsRouter.put(
  '/:id',
  handler(async (req, res) => {
    const body = parseWith(eventSchema, req.body);
    const event = updateEvent(req.user!.id, req.params.id, body);
    if (!event) throw new NotFoundError('Event');
    res.json({ event });
  })
);

eventsRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const deleted = deleteEvent(req.user!.id, req.params.id);
    if (!deleted) throw new NotFoundError('Event');
    res.status(204).send();
  })
);

eventsRouter.post(
  '/:id/done',
  handler(async (req, res) => {
    const event = setEventDone(req.user!.id, req.params.id);
    if (!event) throw new NotFoundError('Event');
    res.json({ event });
  })
);

eventsRouter.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const event = cancelEvent(req.user!.id, req.params.id);
    if (!event) throw new NotFoundError('Event');
    res.json({ event });
  })
);

eventsRouter.post(
  '/:id/snooze',
  handler(async (req, res) => {
    const duration = parseSnoozeDuration(req.body?.duration);
    const event = snoozeEvent(req.user!.id, req.params.id, duration);
    if (!event) throw new NotFoundError('Event');
    res.json({ event });
  })
);

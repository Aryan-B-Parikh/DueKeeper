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
  snoozeEvent
} from './events.service';
import { NotFoundError, ValidationError } from '../../lib/errors';

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
  dueAt: z
    .string()
    .min(1, 'dueAt is required')
    .refine((v) => !Number.isNaN(new Date(v).getTime()), 'dueAt must be a valid ISO date'),
  timezone: z.string().trim().min(1).max(64),
  reminders: z.array(reminderSchema).max(10).optional()
});

function parseSnoozeDuration(input: unknown): string {
  const value = typeof input === 'string' ? input : '';
  const normalized = value.trim().toLowerCase();
  if (!/^\d+[mhd]$/.test(normalized) || normalized === '0m' || normalized === '0h' || normalized === '0d') {
    throw new ValidationError('duration must be a positive value like 30m, 2h or 1d');
  }
  return normalized;
}

eventsRouter.get(
  '/',
  handler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !['all', 'active', 'upcoming', 'due_soon', 'overdue', 'done', 'cancelled'].includes(status)) {
      throw new ValidationError(`Unknown status filter: ${status}`);
    }
    res.json({ events: listEvents(req.user!.id, { status }) });
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

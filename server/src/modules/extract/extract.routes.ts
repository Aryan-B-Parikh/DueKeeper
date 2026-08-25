import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { handler, parseWith, zodDetails } from '../../middleware/validate';
import { createRateLimiter } from '../../lib/rateLimit';
import { RateLimitError, ValidationError } from '../../lib/errors';
import { assertValidImage } from './imageValidate';
import { extractWithGemini, geminiConfigured, type GeminiCandidate } from './gemini';
import { extractHeuristicCandidates } from './heuristic';
import { createEvent } from '../events/events.service';
import { inTransaction } from '../../db/database';
import { createLogger } from '../../lib/logger';
import { ExternalServiceError } from '../../lib/errors';
import { zonedToUtcIso, isValidCivilDate } from './dateUtils';
import { instantSchema, timezoneSchema, isValidTimezone } from '../../lib/datetimeValidation';

const log = createLogger('extract');

export const extractRouter = Router();

extractRouter.use(requireAuth());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

const extractLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

interface ExtractCandidate {
  id: string;
  title: string;
  eventType: 'exam' | 'submission' | 'hackathon' | 'other';
  dueAt: string | null;
  timezone: string;
  confidence: number;
  needsClarification: boolean;
}

function normalizeEventType(value: string | undefined): ExtractCandidate['eventType'] {
  const lowered = (value ?? '').toLowerCase();
  if (['exam', 'submission', 'hackathon', 'other'].includes(lowered)) {
    return lowered as ExtractCandidate['eventType'];
  }
  return 'other';
}

function normalizeConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function mapGeminiCandidates(raw: GeminiCandidate[], timezone: string): ExtractCandidate[] {
  const out: ExtractCandidate[] = [];
  for (let index = 0; index < raw.length && index < 20; index += 1) {
    const item = raw[index];
    if (!item.title || !item.due_date) continue;
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(item.due_date) ? item.due_date : null;
    if (!dueDate) continue;
    const [y, mo, d] = dueDate.split('-').map(Number);
    // Reject overflow dates like 2026-02-31 that JS would silently roll forward.
    if (!isValidCivilDate(y, mo - 1, d)) continue;

    const dueTime = /^\d{2}:\d{2}$/.test(item.due_time ?? '') ? item.due_time! : '23:59';
    const [h, mi] = dueTime.split(':').map(Number);
    if (h > 23 || mi > 59) continue;

    // The model is free to return any string here; only accept it if it is a
    // real IANA zone, otherwise fall back to the user's own.
    const tzRaw = typeof item.timezone === 'string' ? item.timezone.trim().slice(0, 64) : '';
    const tz = tzRaw && isValidTimezone(tzRaw) ? tzRaw : timezone;

    const iso = zonedToUtcIso(y, mo - 1, d, h, mi, tz);
    if (!iso) continue;
    out.push({
      id: `c${index}`,
      title: String(item.title).slice(0, 200),
      eventType: normalizeEventType(item.event_type),
      dueAt: iso,
      timezone: tz,
      confidence: normalizeConfidence(item.confidence),
      needsClarification: Boolean(item.needs_clarification)
    });
  }
  return out;
}

function mapHeuristicCandidates(text: string, timezone: string): ExtractCandidate[] {
  return extractHeuristicCandidates(text, timezone).map((candidate, index) => ({
    id: `c${index}`,
    title: candidate.title,
    eventType: candidate.eventType,
    dueAt: candidate.dueAtIso,
    timezone,
    confidence: candidate.confidence,
    needsClarification: candidate.needsClarification
  }));
}

extractRouter.post(
  '/',
  upload.single('screenshot'),
  handler(async (req, res) => {
    const limit = extractLimiter.take(req.user!.id);
    if (!limit.allowed) {
      throw new RateLimitError(limit.retryAfterSeconds, 'Extraction rate limit reached; try again later');
    }

    // A caller-supplied zone drives every date computation below, so validate it
    // rather than pattern-matching for a slash; fall back to the profile zone.
    const bodyTimezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';
    const userTimezone = bodyTimezone && isValidTimezone(bodyTimezone) ? bodyTimezone : req.user!.timezone;

    const file = req.file;
    let text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!file && !text) {
      throw new ValidationError('Provide either a screenshot file or pastedText');
    }
    if (text.length > 20000) text = text.slice(0, 20000);

    if (file) {
      const info = assertValidImage(file.buffer);
      if (!geminiConfigured()) {
        res.status(422).json({
          error: {
            code: 'EXTRACTOR_UNAVAILABLE',
            message:
              'Screenshot extraction requires GEMINI_API_KEY to be configured. Use the "Paste text" tab meanwhile.'
          }
        });
        return;
      }
      const candidates = mapGeminiCandidates(
        await extractWithGemini({
          text: text || 'Extract deadlines from this screenshot.',
          timezone: userTimezone,
          imageBase64: file.buffer.toString('base64'),
          imageMime: info.mime
        }),
        userTimezone
      );
      res.json({ engine: 'gemini', candidates });
      return;
    }

    if (geminiConfigured()) {
      try {
        const candidates = mapGeminiCandidates(
          await extractWithGemini({ text, timezone: userTimezone }),
          userTimezone
        );
        res.json({ engine: 'gemini', candidates });
        return;
      } catch (err) {
        if (!(err instanceof ExternalServiceError)) throw err;
        // Falling back to the heuristic parser is the point of catching this, but
        // silently is not: a permanently misconfigured key would otherwise look
        // like a working-but-poor extractor forever.
        log.warn(`Gemini extraction failed, falling back to heuristics: ${err.message}`);
      }
    }

    const candidates = mapHeuristicCandidates(text, userTimezone);
    res.json({ engine: 'heuristic', candidates });
  })
);

const confirmSchema = z.object({
  source: z.enum(['ai_text', 'ai_screenshot']).default('ai_text'),
  events: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        eventType: z.enum(['exam', 'submission', 'hackathon', 'other']),
        // Same strictness as POST /events: this endpoint writes real events, so
        // it cannot be the weaker door into the same table (H5).
        dueAt: instantSchema,
        timezone: timezoneSchema,
        reminders: z
          .array(
            z.object({
              offsetSeconds: z.number().int().min(0).max(604800),
              channel: z.enum(['email', 'in_app'])
            })
          )
          .optional()
      })
    )
    .min(1)
    .max(20)
});

extractRouter.post(
  '/confirm',
  handler(async (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Confirm payload invalid', zodDetails(parsed.error));
    }
    // All or nothing: the user confirmed a batch, and a partial write leaves them
    // guessing which of the twenty deadlines actually saved.
    const created = inTransaction(() =>
      parsed.data.events.map((eventInput) =>
        createEvent(req.user!.id, {
          ...eventInput,
          description: null,
          source: parsed.data.source,
          aiConfidence: null,
          confirmationStatus: 'user_confirmed'
        })
      )
    );
    res.status(201).json({ events: created });
  })
);

export type { ExtractCandidate };

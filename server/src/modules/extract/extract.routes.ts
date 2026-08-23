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
import { ExternalServiceError } from '../../lib/errors';

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
    const dueTime = /^\d{2}:\d{2}$/.test(item.due_time ?? '') ? item.due_time! : '23:59';
    const tz = item.timezone && item.timezone.includes('/') ? item.timezone : timezone;
    try {
      const [y, mo, d] = dueDate.split('-').map(Number);
      const [h, mi] = dueTime.split(':').map(Number);
      const naive = Date.UTC(y, mo - 1, d, h, mi);
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const parts = dtf.formatToParts(new Date(naive));
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
      const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      const offsetMin = Math.round((asUtc - naive) / 60_000);
      const iso = new Date(naive - offsetMin * 60_000).toISOString();
      out.push({
        id: `c${index}`,
        title: String(item.title).slice(0, 200),
        eventType: normalizeEventType(item.event_type),
        dueAt: iso,
        timezone: tz,
        confidence: normalizeConfidence(item.confidence),
        needsClarification: Boolean(item.needs_clarification)
      });
    } catch {
      continue;
    }
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

    const userTimezone =
      typeof req.body?.timezone === 'string' && req.body.timezone.includes('/')
        ? req.body.timezone
        : req.user!.timezone;

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
        dueAt: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid dueAt'),
        timezone: z.string().trim().min(1).max(64),
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
    const created = parsed.data.events.map((eventInput) =>
      createEvent(req.user!.id, {
        ...eventInput,
        description: null,
        source: parsed.data.source,
        aiConfidence: null,
        confirmationStatus: 'user_confirmed'
      })
    );
    res.status(201).json({ events: created });
  })
);

export type { ExtractCandidate };

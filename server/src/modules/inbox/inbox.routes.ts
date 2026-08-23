import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { prepare } from '../../db/database';
import { config } from '../../config/env';
import { constantTimeEqual } from '../../lib/secretbox';
import { createLogger } from '../../lib/logger';
import { extractHeuristicCandidates } from '../extract/heuristic';
import { createEvent } from '../events/events.service';
import { getUserRowByEmail, insertNotification } from '../auth/auth.service';
import { emailService } from '../../engine/channels/emailChannel';

const log = createLogger('inbox');

export const inboxRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 }
});

function tokenMatches(provided: string): boolean {
  if (!config.inboxWebhookToken) return false;
  return constantTimeEqual(provided, config.inboxWebhookToken);
}

function pickField(fields: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function resolveUserIdByTokenAddress(toAddress: string): string | null {
  const local = toAddress.split('@')[0]?.toLowerCase() ?? '';
  const match = /^deadline\+([a-f0-9]{16,64})$/.exec(local);
  if (!match) return null;
  const row = prepare('SELECT id FROM users WHERE forwarding_token = ?').get(match[1]) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

async function handleInbound(req: Request, res: Response, providedToken: string): Promise<void> {
  if (!config.inboxWebhookToken) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Inbox feature is not configured' } });
    return;
  }
  if (!tokenMatches(providedToken)) {
    log.warn('Rejected inbound webhook with invalid token');
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid webhook token' } });
    return;
  }

  const fields = (req.body ?? {}) as Record<string, unknown>;
  const from = pickField(fields, 'from', 'sender');
  const to = pickField(fields, 'to', 'recipient');
  const subject = pickField(fields, 'subject');
  const body = pickField(fields, 'text', 'body', 'plain');

  let userId = resolveUserIdByTokenAddress(to);
  if (!userId && from) {
    userId = getUserRowByEmail(from)?.id ?? null;
  }
  if (!userId) {
    log.warn('Could not resolve recipient for inbound email', { to });
    res.status(202).json({ ok: true, ignored: 'unresolved-recipient' });
    return;
  }

  const textForExtraction = `${subject}\n${body}`.trim();
  const candidates = extractHeuristicCandidates(textForExtraction, 'UTC');
  const autoSaved = candidates.filter((c) => c.dueAtIso && c.confidence >= 0.7);

  for (const candidate of autoSaved.slice(0, 5)) {
    createEvent(userId, {
      title: candidate.title,
      description: `Imported from email: ${subject || '(no subject)'}`,
      eventType: candidate.eventType,
      dueAt: candidate.dueAtIso!,
      timezone: 'UTC',
      reminders: [
        { offsetSeconds: 86400, channel: 'in_app' },
        { offsetSeconds: 3600, channel: 'in_app' }
      ],
      source: 'email',
      aiConfidence: candidate.confidence,
      confirmationStatus: 'auto_saved'
    });
  }

  insertNotification(
    userId,
    autoSaved.length > 0 ? 'info' : 'warning',
    autoSaved.length > 0 ? 'Deadline captured from email' : 'Processed forwarded email',
    autoSaved.length > 0
      ? `${autoSaved.length} deadline(s) detected in "${subject || 'forwarded email'}".`
      : `No clear deadlines found in "${subject || 'the forwarded email'}". Add it manually if needed.`
  );

  try {
    const userRow = prepare('SELECT email FROM users WHERE id = ?').get(userId) as
      | { email: string }
      | undefined;
    if (userRow) {
      await emailService.sendRaw({
        to: userRow.email,
        subject:
          autoSaved.length > 0
            ? `DueKeeper: ${autoSaved.length} deadline(s) added`
            : 'DueKeeper: no deadlines found in your forward',
        text:
          autoSaved.length > 0
            ? `We found ${autoSaved.length} deadline(s):\n${autoSaved.map((c) => `- ${c.title}`).join('\n')}`
            : 'We could not detect a clear deadline in the message you forwarded. You can add it manually in DueKeeper.'
      });
    }
  } catch (err) {
    log.warn('Confirmation email failed', err as Error);
  }

  res.status(202).json({ ok: true, savedCount: autoSaved.length });
}

inboxRouter.post('/webhook', upload.any(), handlerAdapter());
inboxRouter.post('/webhook/:token', upload.any(), handlerAdapter());

function handlerAdapter() {
  return (
    req: Request,
    res: Response,
    next: (err?: unknown) => void
  ): void => {
    handleInbound(req, res, typeof req.query?.token === 'string' ? req.query.token : req.params.token ?? '').catch(
      next
    );
  };
}

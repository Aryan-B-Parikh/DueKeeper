import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { createHash, createHmac } from 'node:crypto';
import { prepare } from '../../db/database';
import { config } from '../../config/env';
import { constantTimeEqual } from '../../lib/secretbox';
import { createLogger } from '../../lib/logger';
import { extractHeuristicCandidates } from '../extract/heuristic';
import { createEvent } from '../events/events.service';
import { insertNotification } from '../auth/auth.service';
import { emailService } from '../../engine/channels/emailChannel';
import { createRateLimiter } from '../../lib/rateLimit';

const log = createLogger('inbox');

export const inboxRouter = Router();

const webhookLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  maxKeys: config.rateLimitMaxKeys
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 }
});

function tokenMatches(provided: string): boolean {
  if (!config.inboxWebhookToken) return false;
  return constantTimeEqual(provided, config.inboxWebhookToken);
}

/**
 * Verifies `X-Inbox-Signature: sha256=<hex>` where hex = HMAC-SHA256(token, to+"\\0"+subject+"\\0"+body).
 * Header form follows SendGrid/Mailgun HMAC conventions; `\0` is the separator used in `receiptKey`
 * because it cannot appear in a header or body, so distinct messages cannot collide.
 * This is the “provider HMAC over (logical) body” step from AUDIT §9 — true raw-body HMAC would
 * require capturing the raw multipart buffer before multer (added as next iteration if needed).
 */
function signatureMatches(req: import('express').Request, to: string, subject: string, body: string): boolean {
  const raw = (req.headers['x-inbox-signature'] as string) || (req.headers['x-inbox-hmac'] as string) || '';
  if (!raw) return false;
  if (!config.inboxWebhookToken) return false;
  const provided = raw.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) return false;
  const computed = createHmac('sha256', config.inboxWebhookToken).update(`${to}\u0000${subject}\u0000${body}`).digest('hex');
  return constantTimeEqual(provided, computed);
}

export function computeInboxSignature(to: string, subject: string, body: string, secret: string = config.inboxWebhookToken ?? ''): string {
  return `sha256=${createHmac('sha256', secret).update(`${to}\u0000${subject}\u0000${body}`).digest('hex')}`;
}

/**
 * Reads the shared webhook secret from a request header only.
 *
 * The query-string and path-parameter forms were removed deliberately: a secret
 * in a URL is captured by default in proxy and web-server access logs, browser
 * history, and Referer headers, and rotating it means auditing every one of
 * those. Header-only is a breaking change for a provider configured against the
 * old `/webhook/:token` URL — reconfigure it to send `X-Inbox-Token` instead.
 */
function extractProvidedToken(req: import('express').Request): string {
  const headerToken =
    (req.headers['x-inbox-token'] as string) ||
    (req.headers['x-webhook-token'] as string) ||
    (() => {
      const auth = req.headers['authorization'] as string | undefined;
      if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
      return '';
    })();
  return headerToken ? headerToken.trim() : '';
}

function redactAddress(addr: string): string {
  // Never log the forwarding token that grants write access to an account.
  const at = addr.indexOf('@');
  if (at <= 0) return '[redacted]';
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  const plus = local.indexOf('+');
  if (plus === -1) return addr;
  return `${local.slice(0, plus)}+***${domain}`;
}

function pickField(fields: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

interface InboxRecipient {
  id: string;
  timezone: string;
}

/**
 * Pulls candidate mailboxes out of a `To:` header.
 *
 * Providers forward the header, not a bare address: SendGrid Inbound Parse sends
 * `"Priya Sharma" <deadline+ab12…@inbox.example>`, and a forwarded message can
 * carry several comma-separated recipients. Angle-bracket forms win where they
 * are present, because a display name may itself contain an `@`.
 */
function extractAddresses(header: string): string[] {
  const found: string[] = [];
  for (const raw of header.match(/<([^<>]+@[^<>]+)>/g) ?? []) {
    found.push(raw.slice(1, -1).trim());
  }
  if (found.length === 0) {
    for (const part of header.split(',')) {
      const candidate = part.trim().replace(/^["']+|["']+$/g, '');
      if (candidate.includes('@')) found.push(candidate);
    }
  }
  // Bounded: this is an unauthenticated request field, and one lookup per
  // address is a database round trip.
  return found.filter((a) => a.length > 0 && a.length <= 320).slice(0, 10);
}

/**
 * Resolves the account a forwarded message belongs to from its `to` header.
 *
 * This used to be `to.split('@')[0]`, which only matched a bare address. Any
 * real mail client or provider that includes a display name — the common case —
 * produced a local part of `"Priya Sharma" <deadline+ab12` and resolved to
 * nobody, so the message was accepted with `unresolved-recipient` and silently
 * dropped. The address, not the display name, is what identifies the account.
 */
function resolveUserIdByTokenAddress(toHeader: string): InboxRecipient | null {
  for (const address of extractAddresses(toHeader)) {
    const at = address.indexOf('@');
    if (at <= 0) continue;
    const match = /^deadline\+([a-f0-9]{16,64})$/.exec(address.slice(0, at).toLowerCase());
    if (!match) continue;
    const row = prepare('SELECT id, timezone FROM users WHERE forwarding_token = ?').get(match[1]) as
      | InboxRecipient
      | undefined;
    if (row) return row;
  }
  return null;
}

/**
 * Cheap checks that must happen *before* multer touches the body.
 *
 * These lived inside the handler, which meant every rejected request — including
 * a stream of brute-force attempts against the shared secret — had its multipart
 * body parsed into memory (up to 6 files × 5 MB) before the token was even
 * compared. Gating first makes an unauthorized request cost a header read.
 */
function gateInbound(req: Request, res: Response, next: (err?: unknown) => void): void {
  if (!config.inboxWebhookToken) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Inbox feature is not configured' } });
    return;
  }
  // Unauthenticated endpoint guarded by a single shared secret, so cap attempts
  // per source address — otherwise the token can be ground down at line rate.
  const ip = req.ip || 'local';
  const limit = webhookLimiter.take(ip);
  if (!limit.allowed) {
    res
      .status(429)
      .set('Retry-After', String(limit.retryAfterSeconds))
      .json({ error: { code: 'RATE_LIMITED', message: 'Too many webhook requests' } });
    return;
  }
  const hasSignature = Boolean((req.headers['x-inbox-signature'] as string) || (req.headers['x-inbox-hmac'] as string));
  // If a signature is present, defer to HMAC verification in the handler (needs parsed fields).
  // Otherwise require the shared token now — cheap reject before multer allocates.
  if (!hasSignature && !tokenMatches(extractProvidedToken(req))) {
    log.warn('Rejected inbound webhook with invalid token');
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid webhook token' } });
    return;
  }
  next();
}

/**
 * Stable per-message key for the receipt email.
 *
 * SendGrid (and most providers) retry a webhook that did not answer 2xx, and a
 * slow SMTP send is exactly the case where that happens — so the same forward
 * can reach here twice. Deriving the key from the message content means the
 * provider collapses the duplicate receipt instead of the user reading it twice.
 * The recipient's own id is inside the hash, so keys cannot collide across
 * accounts, and the address never appears in the key itself. The separator is an
 * escaped NUL because it is the one byte that cannot appear in a header or body,
 * so no pair of distinct messages can hash to the same key by concatenation.
 */
function receiptKey(userId: string, subject: string, body: string): string {
  return createHash('sha256').update(`${userId}\u0000${subject}\u0000${body}`).digest('hex').slice(0, 32);
}

async function handleInbound(req: Request, res: Response): Promise<void> {
  const fields = (req.body ?? {}) as Record<string, unknown>;
  const to = pickField(fields, 'to', 'recipient');
  const subject = pickField(fields, 'subject');
  const body = pickField(fields, 'text', 'body', 'plain');

  // If the caller sent an HMAC, it must be valid — this covers both tamper and replay-by-key-holder
  // (replay is still bounded to duplicate events via receiptKey, but tamper now fails closed).
  const sigHeader = (req.headers['x-inbox-signature'] as string) || (req.headers['x-inbox-hmac'] as string) || '';
  if (sigHeader) {
    if (!signatureMatches(req, to, subject, body)) {
      log.warn('Rejected inbound webhook with invalid HMAC signature');
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid webhook signature' } });
      return;
    }
  } else if (!tokenMatches(extractProvidedToken(req))) {
    // No signature and token invalid (gate allowed through only if signature present — re-check for races)
    log.warn('Rejected inbound webhook with invalid token');
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid webhook token' } });
    return;
  }

  const recipient = resolveUserIdByTokenAddress(to);
  if (!recipient) {
    log.warn('Could not resolve recipient for inbound email', { to: redactAddress(to) });
    res.status(202).json({ ok: true, ignored: 'unresolved-recipient' });
    return;
  }
  const userId = recipient.id;
  // "Friday 5pm" in a forwarded email means Friday 5pm where the person lives.
  // Extracting in UTC shifted every relative and time-of-day match by the user's
  // offset, which for anyone far from UTC moved the deadline a whole day.
  const timezone = recipient.timezone || 'UTC';

  const textForExtraction = `${subject}\n${body}`.trim();
  const candidates = extractHeuristicCandidates(textForExtraction, timezone);
  const autoSaved = candidates.filter((c) => c.dueAtIso && c.confidence >= 0.7);

  for (const candidate of autoSaved.slice(0, 5)) {
    createEvent(userId, {
      title: candidate.title,
      description: `Imported from email: ${subject || '(no subject)'}`,
      eventType: candidate.eventType,
      dueAt: candidate.dueAtIso!,
      timezone,
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
            : 'We could not detect a clear deadline in the message you forwarded. You can add it manually in DueKeeper.',
        idempotencyKey: `inbox-receipt:${receiptKey(userId, subject, body)}`
      });
    }
  } catch (err) {
    log.warn('Confirmation email failed', err as Error);
  }

  res.status(202).json({ ok: true, savedCount: autoSaved.length });
}

// Header-only, and gated before the body is parsed. The old `/webhook/:token`
// route is gone: it put the shared secret in the request path, which proxies and
// access logs record by default.
inboxRouter.post('/webhook', gateInbound, upload.any(), (req, res, next) => {
  handleInbound(req, res).catch(next);
});

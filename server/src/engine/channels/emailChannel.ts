import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';

const log = createLogger('email');

export interface RawMail {
  to: string;
  subject: string;
  text: string;
  /**
   * Stable, per-delivery identifier. A retry after a timeout may be re-sending
   * mail the MTA already accepted; carrying the same Message-ID and
   * X-Entity-Ref-ID lets the provider collapse the duplicate instead of the
   * user getting the same reminder two or three times.
   */
  idempotencyKey?: string;
}

export interface EmailService {
  readonly mode: 'smtp' | 'console';
  sendRaw(mail: RawMail): Promise<void>;
}

class ConsoleEmailService implements EmailService {
  readonly mode = 'console' as const;

  async sendRaw(mail: RawMail): Promise<void> {
    log.info(
      `[DEV EMAIL] to=${mail.to} subject="${mail.subject}" body=${JSON.stringify(mail.text.slice(0, 300))}`
    );
  }
}

class SmtpEmailService implements EmailService {
  readonly mode = 'smtp' as const;
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
      connectionTimeout: config.smtpTimeoutMs,
      greetingTimeout: config.smtpTimeoutMs,
      socketTimeout: config.smtpTimeoutMs
    });
  }

  async sendRaw(mail: RawMail): Promise<void> {
    const domain = config.emailFrom.match(/@([^>\s]+)/)?.[1] ?? 'duekeeper.local';
    const messageId = mail.idempotencyKey ? `<${mail.idempotencyKey}@${domain}>` : undefined;
    await this.transporter.sendMail({
      from: config.emailFrom,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId,
      headers: mail.idempotencyKey ? { 'X-Entity-Ref-ID': mail.idempotencyKey } : undefined
    });
  }
}

function resolveEmailService(): EmailService {
  if (config.smtpHost) {
    log.info(`SMTP email delivery enabled via ${config.smtpHost}:${config.smtpPort}`);
    return new SmtpEmailService();
  }
  if (config.isProd) {
    // Silent degradation to console in production masks the outage and the
    // outbox then marks the job 'sent' — fail loudly so deployment catches it.
    throw new Error('SMTP_HOST is required in production; refusing to start with console email fallback');
  }
  log.warn('SMTP not configured; emails will be logged to console (dev mode)');
  return new ConsoleEmailService();
}

export const emailService: EmailService = resolveEmailService();

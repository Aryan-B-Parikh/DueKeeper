import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';

const log = createLogger('email');

export interface RawMail {
  to: string;
  subject: string;
  text: string;
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
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined
    });
  }

  async sendRaw(mail: RawMail): Promise<void> {
    await this.transporter.sendMail({
      from: config.emailFrom,
      to: mail.to,
      subject: mail.subject,
      text: mail.text
    });
  }
}

function resolveEmailService(): EmailService {
  if (config.smtpHost) {
    log.info(`SMTP email delivery enabled via ${config.smtpHost}:${config.smtpPort}`);
    return new SmtpEmailService();
  }
  log.info('SMTP not configured; emails will be logged to console (dev mode)');
  return new ConsoleEmailService();
}

export const emailService: EmailService = resolveEmailService();

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../lib/logger';

const log = createLogger('config');

function loadDotEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    log.info(`Loaded environment from ${path}`);
    return;
  }
}

loadDotEnv();

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProd: boolean;
  port: number;
  appBaseUrl: string;
  webAppUrl: string;
  dbPath: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  refreshTokenTtlDays: number;
  loginRateLimit: number;
  registerRateLimit: number;
  corsAllowedOrigins: string[];
  geminiApiKey?: string;
  geminiModel: string;
  smtpHost?: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPass?: string;
  emailFrom: string;
  inboxDomain: string;
  inboxWebhookToken?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  outboxLeaseSeconds: number;
  outboxClaimLimit: number;
  outboxMaxAttempts: number;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config: AppConfig = {
  nodeEnv: (str('NODE_ENV', 'development') as AppConfig['nodeEnv']),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 8080),
  appBaseUrl: str('APP_BASE_URL', `http://localhost:${num('PORT', 8080)}`).replace(/\/$/, ''),
  webAppUrl: str('WEB_APP_URL', `http://localhost:${num('PORT', 3000) === 8080 ? 3000 : num('WEB_APP_URL_PORT', 3000)}`).replace(/\/$/, ''),
  dbPath: str('DB_PATH', './data/duekeeper.db'),
  jwtSecret: str('JWT_SECRET', ''),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '15m'),
  refreshTokenTtlDays: num('REFRESH_TOKEN_TTL_DAYS', 30),
  loginRateLimit: num('LOGIN_RATE_LIMIT', 10),
  registerRateLimit: num('REGISTER_RATE_LIMIT', 30),
  corsAllowedOrigins: str('CORS_ALLOWED_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  geminiApiKey: optional('GEMINI_API_KEY'),
  geminiModel: str('GEMINI_MODEL', 'gemini-2.5-flash'),
  smtpHost: optional('SMTP_HOST'),
  smtpPort: num('SMTP_PORT', 587),
  smtpUser: optional('SMTP_USER'),
  smtpPass: optional('SMTP_PASS'),
  emailFrom: str('EMAIL_FROM', 'DueKeeper <no-reply@duekeeper.local>'),
  inboxDomain: str('INBOX_DOMAIN', 'inbox.duekeeper.local'),
  inboxWebhookToken: optional('INBOX_WEBHOOK_TOKEN'),
  googleClientId: optional('GOOGLE_CLIENT_ID'),
  googleClientSecret: optional('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: optional('GOOGLE_REDIRECT_URI'),
  vapidPublicKey: optional('VAPID_PUBLIC_KEY'),
  vapidPrivateKey: optional('VAPID_PRIVATE_KEY'),
  outboxLeaseSeconds: num('OUTBOX_LEASE_SECONDS', 120),
  outboxClaimLimit: num('OUTBOX_CLAIM_LIMIT', 50),
  outboxMaxAttempts: num('OUTBOX_MAX_ATTEMPTS', 3)
};

if (!config.isProd) {
  if (!process.env.JWT_SECRET) {
    config.jwtSecret = `dev-insecure-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    log.warn('JWT_SECRET not set; using an ephemeral dev secret. Tokens will not survive restarts.');
  }
} else {
  const problems: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be set to at least 32 characters');
  }
  if (!process.env.ENCRYPTION_KEY) {
    problems.push('ENCRYPTION_KEY must be set (base64-encoded 32 bytes)');
  }
  if (config.appBaseUrl.startsWith('http://')) {
    problems.push('APP_BASE_URL must be HTTPS in production');
  }
  if (config.corsAllowedOrigins.some((o) => o.includes('localhost'))) {
    problems.push('CORS_ALLOWED_ORIGINS must not contain localhost in production');
  }
  if (problems.length > 0) {
    log.error('Refusing to start with unsafe production configuration');
    for (const p of problems) log.error(`  - ${p}`);
    throw new Error(`Unsafe production configuration:\n${problems.join('\n')}`);
  }
}

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
  outboxMaxReclaims: number;
  outboxConcurrency: number;
  plannerGraceSeconds: number;
  plannerBatchLimit: number;
  reconcileBatchLimit: number;
  outboundFetchTimeoutMs: number;
  smtpTimeoutMs: number;
  encryptionKey?: string;
  previousEncryptionKeys: string[];
  sseMaxConnectionsPerUser: number;
  rateLimitMaxKeys: number;
  pushSubscriptionsPerUser: number;
  maxListPageSize: number;
  databaseUrl?: string;
  redisUrl?: string;
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

/** Integer in [min, max]; out-of-range or non-integer input falls back rather
 * than silently configuring, say, a zero-second lease or an unbounded batch. */
function intInRange(name: string, fallback: number, min: number, max: number): number {
  const n = num(name, fallback);
  if (!Number.isInteger(n) || n < min || n > max) {
    if (process.env[name] !== undefined && process.env[name]?.trim() !== '') {
      log.warn(`${name}="${process.env[name]}" is not an integer in [${min}, ${max}]; using ${fallback}`);
    }
    return fallback;
  }
  return n;
}

function list(name: string): string[] {
  return str(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Checks that a value really is a base64-encoded 32-byte key.
 *
 * `Buffer.from(x, 'base64')` never throws — it silently drops every character
 * outside the alphabet — so decoding alone cannot tell a good key from a mangled
 * paste. The charset test is what actually catches the accident; the length test
 * then catches truncation. Both alphabets are accepted because `base64url` is
 * what most key-generation snippets emit.
 */
function base64KeyProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return 'is not valid base64';
  if (Buffer.from(trimmed, 'base64').length !== 32) return 'must decode to exactly 32 bytes';
  return null;
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
  outboxLeaseSeconds: intInRange('OUTBOX_LEASE_SECONDS', 120, 10, 3600),
  outboxClaimLimit: intInRange('OUTBOX_CLAIM_LIMIT', 50, 1, 500),
  outboxMaxAttempts: intInRange('OUTBOX_MAX_ATTEMPTS', 3, 1, 10),
  outboxMaxReclaims: intInRange('OUTBOX_MAX_RECLAIMS', 3, 0, 20),
  outboxConcurrency: intInRange('OUTBOX_CONCURRENCY', 5, 1, 20),
  plannerGraceSeconds: intInRange('PLANNER_GRACE_SECONDS', 60, 0, 3600),
  plannerBatchLimit: intInRange('PLANNER_BATCH_LIMIT', 500, 10, 5000),
  reconcileBatchLimit: intInRange('RECONCILE_BATCH_LIMIT', 100, 10, 1000),
  outboundFetchTimeoutMs: intInRange('OUTBOUND_FETCH_TIMEOUT_MS', 10000, 1000, 120000),
  smtpTimeoutMs: intInRange('SMTP_TIMEOUT_MS', 10000, 1000, 120000),
  encryptionKey: optional('ENCRYPTION_KEY'),
  previousEncryptionKeys: list('PREVIOUS_ENCRYPTION_KEYS'),
  sseMaxConnectionsPerUser: intInRange('SSE_MAX_CONNECTIONS_PER_USER', 5, 1, 100),
  rateLimitMaxKeys: intInRange('RATE_LIMIT_MAX_KEYS', 10000, 100, 1000000),
  pushSubscriptionsPerUser: intInRange('PUSH_SUBSCRIPTIONS_PER_USER', 20, 1, 100),
  maxListPageSize: intInRange('MAX_LIST_PAGE_SIZE', 100, 10, 1000),
  databaseUrl: optional('DATABASE_URL'),
  redisUrl: optional('REDIS_URL')
};

if (!config.isProd) {
  if (!process.env.JWT_SECRET) {
    config.jwtSecret = `dev-insecure-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    log.warn('JWT_SECRET not set; using an ephemeral dev secret. Tokens will not survive restarts.');
  }
} else {
  const allowLocalE2E = process.env.ALLOW_LOCALHOST_E2E === '1';
  const problems: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be set to at least 32 characters');
  }
  if (!config.encryptionKey) {
    problems.push('ENCRYPTION_KEY must be set (base64-encoded 32 bytes)');
  } else {
    const problem = base64KeyProblem(config.encryptionKey);
    if (problem) problems.push(`ENCRYPTION_KEY ${problem}`);
  }
  config.previousEncryptionKeys.forEach((key, index) => {
    const problem = base64KeyProblem(key);
    if (problem) {
      // A malformed entry here is worse than a missing one. The operator believes
      // rotation is covered; the key is quietly discarded instead, and every row
      // still encrypted under it fails to decrypt at the moment it is needed —
      // which for a Google connection means sync breaking with no way back but a
      // reconnect. Refuse to start rather than discover it during an outage.
      problems.push(`PREVIOUS_ENCRYPTION_KEYS[${index}] ${problem}`);
    }
  });
  if (config.appBaseUrl.startsWith('http://')) {
    if (allowLocalE2E) {
      log.warn('ALLOW_LOCALHOST_E2E=1 — permitting non-HTTPS APP_BASE_URL for local end-to-end testing ONLY');
    } else {
      problems.push('APP_BASE_URL must be HTTPS in production');
    }
  }
  if (config.corsAllowedOrigins.some((o) => o.includes('localhost'))) {
    if (allowLocalE2E) {
      log.warn('ALLOW_LOCALHOST_E2E=1 — permitting localhost CORS origins for local end-to-end testing ONLY');
    } else {
      problems.push('CORS_ALLOWED_ORIGINS must not contain localhost in production');
    }
  }
  if (!config.smtpHost) {
    // Without this the outbox silently "delivers" every reminder email to the
    // server console and marks the job sent — a total, invisible loss of the
    // product's core function in production.
    problems.push('SMTP_HOST must be set in production (email delivery would otherwise be dropped)');
  }
  if (config.jwtSecret && config.encryptionKey && config.jwtSecret === config.encryptionKey) {
    problems.push('ENCRYPTION_KEY must differ from JWT_SECRET (key separation)');
  }
  if (problems.length > 0) {
    log.error('Refusing to start with unsafe production configuration');
    for (const p of problems) log.error(`  - ${p}`);
    throw new Error(`Unsafe production configuration:\n${problems.join('\n')}`);
  }
}

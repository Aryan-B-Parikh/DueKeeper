import { prepare } from '../../db/database';
import { hashPassword, verifyPassword } from '../../lib/password';
import { issueTokenPair, type TokenPair } from '../../lib/tokens';
import { config } from '../../config/env';
import { ConflictError, UnauthorizedError } from '../../lib/errors';
import { uuid, token as randomToken } from '../../lib/ids';
import { nowIso } from '../../lib/time';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  notificationPrefs: Record<string, boolean>;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  timezone: string;
  notification_prefs: string;
  forwarding_token: string;
  token_version: number;
  created_at: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  let prefs: Record<string, boolean> = {};
  try {
    prefs = JSON.parse(row.notification_prefs) as Record<string, boolean>;
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    timezone: row.timezone,
    notificationPrefs: prefs,
    createdAt: row.created_at
  };
}



const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerUser(input: {
  email: string;
  password: string;
  displayName: string;
}): TokenPair & { user: PublicUser } {
  const email = input.email.trim().toLowerCase();
  const existing = prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }
  const id = uuid();
  const now = nowIso();
  const passwordHash = hashPassword(input.password);
  prepare(
    `INSERT INTO users (id, email, password_hash, display_name, timezone, notification_prefs, forwarding_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UTC', '{}', ?, ?, ?)`
  ).run(id, email, passwordHash, input.displayName.trim(), randomToken(16), now, now);

  insertNotification(
    id,
    'system',
    'Welcome to DueKeeper',
    'Add your first deadline or forward emails to your DueKeeper address to get started.'
  );

  const row = getUserRowById(id) as UserRow;
  return { ...issueTokenPair(row), user: toPublicUser(row) };
}

export function loginUser(
  email: string,
  password: string
): TokenPair & { user: PublicUser } {
  const normalized = email.trim().toLowerCase();
  const row = getUserRowByEmail(normalized);
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new UnauthorizedError('Incorrect email or password');
  }
  return { ...issueTokenPair(row), user: toPublicUser(row) };
}

export function getUserRowById(id: string): UserRow | undefined {
  return prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserRowByEmail(email: string): UserRow | undefined {
  return prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function insertNotification(
  userId: string,
  type: 'reminder' | 'system' | 'info' | 'warning',
  title: string,
  body: string,
  options?: { eventId?: string | null; idempotencyKey?: string }
): {
  id: string;
  eventId: string | null;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
} | null {
  const id = uuid();
  const result = prepare(
    `INSERT OR IGNORE INTO notifications (id, user_id, event_id, type, title, body, read, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    userId,
    options?.eventId ?? null,
    type,
    title,
    body,
    options?.idempotencyKey ?? null,
    nowIso()
  );
  if (result.changes === 0 && options?.idempotencyKey) {
    return null;
  }
  return {
    id,
    eventId: options?.eventId ?? null,
    type,
    title,
    body,
    read: false,
    createdAt: nowIso()
  };
}

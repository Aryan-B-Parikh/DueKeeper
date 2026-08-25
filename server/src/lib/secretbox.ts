import { config } from '../config/env';
import { createLogger } from './logger';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

const log = createLogger('secretbox');

let cachedCurrentKey: Buffer | null = null;
let cachedAllKeys: Map<string, Buffer> | null = null;

function getCurrentKey(): Buffer {
  if (cachedCurrentKey) return cachedCurrentKey;
  const raw = config.encryptionKey?.trim() || process.env.ENCRYPTION_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`ENCRYPTION_KEY must be base64-encoded 32 bytes (got ${key.length})`);
    cachedCurrentKey = key;
    return cachedCurrentKey;
  }
  if (config.isProd) throw new Error('ENCRYPTION_KEY is required in production');
  // Dev fallback: random key per boot, not derived from JWT_SECRET (key separation).
  const devKey = randomBytes(32);
  cachedCurrentKey = devKey;
  return cachedCurrentKey;
}

function getAllKeys(): Map<string, Buffer> {
  if (cachedAllKeys) return cachedAllKeys;
  const map = new Map<string, Buffer>();
  const current = getCurrentKey();
  map.set('v1', current);
  // Previous keys allow rotation without breaking existing encrypted rows.
  // They are expected as base64 32-byte strings in PREVIOUS_ENCRYPTION_KEYS.
  const prevs = config.previousEncryptionKeys ?? [];
  for (let i = 0; i < prevs.length; i++) {
    const raw = prevs[i].trim();
    if (!raw) continue;
    // Buffer's base64 decoder never throws — it drops unknown characters — so
    // length is the only usable check here. A rejected key used to be skipped in
    // silence, which turns a typo in a rotation into rows that can no longer be
    // decrypted with no indication why; production now refuses to start on one
    // (see config/env.ts), and in development this is at least loud.
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) {
      map.set(`v1_prev_${i}`, key);
    } else {
      log.error(
        `PREVIOUS_ENCRYPTION_KEYS[${i}] is not a base64-encoded 32-byte key (got ${key.length} bytes) and will not be used; ` +
          'secrets encrypted under it cannot be decrypted'
      );
    }
  }
  cachedAllKeys = map;
  return map;
}

export function resetSecretboxCache(): void {
  cachedCurrentKey = null;
  cachedAllKeys = null;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getCurrentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${Buffer.concat([encrypted, tag]).toString('base64url')}`;
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const version = parts[0];
  const iv = Buffer.from(parts[1], 'base64url');
  const blob = Buffer.from(parts[2], 'base64url');
  // Node's base64url decoder is lenient and silently drops invalid characters,
  // so length is the only real check that the payload is shaped like one of ours.
  // A non-12-byte IV is also accepted by createDecipheriv for GCM, which changes
  // the counter derivation instead of failing.
  if (iv.length !== 12) throw new Error('Invalid encrypted payload IV');
  if (blob.length < 16) throw new Error('Encrypted payload too short');
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  // Try current key first, then previous keys for rotation support.
  const candidates: Buffer[] = [];
  if (version === 'v1') {
    candidates.push(...getAllKeys().values());
  } else {
    throw new Error(`Unsupported encrypted payload version ${version}`);
  }
  let lastErr: unknown = null;
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to decrypt secret');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

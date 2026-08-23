import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be base64-encoded 32 bytes');
    }
    cachedKey = key;
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY is required in production');
  }
  const fallback = createHash('sha256').update(`duekeeper-dev-${process.env.JWT_SECRET ?? 'dev'}`).digest();
  cachedKey = fallback;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${Buffer.concat([encrypted, tag]).toString('base64url')}`;
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const blob = Buffer.from(parts[2], 'base64url');
  if (blob.length < 16) throw new Error('Encrypted payload too short');
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

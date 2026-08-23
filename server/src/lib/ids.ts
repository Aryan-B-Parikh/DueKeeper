import { randomUUID, randomBytes } from 'crypto';

export function uuid(): string {
  return randomUUID();
}

export function shortId(): string {
  return randomBytes(6).toString('hex');
}

export function token(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

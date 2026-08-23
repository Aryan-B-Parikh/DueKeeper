import { createHmac, timingSafeEqual } from 'crypto';

const HEADER = { alg: 'HS256', typ: 'JWT' };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export interface JwtPayload {
  sub: string;
  email: string;
  ver?: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

interface SignInput {
  sub: string;
  email: string;
  ver?: number;
}

function parseExpiresIn(expiresIn: string | number): number {
  if (typeof expiresIn === 'number') return expiresIn;
  const match = /^(\d+)([smhd])$/.exec(expiresIn.trim());
  if (!match) throw new Error(`Invalid expiresIn: ${expiresIn}`);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * multipliers[match[2]];
}

export function signJwt(payload: SignInput, secret: string, expiresIn: string | number = '7d'): string {
  const iat = Math.floor(Date.now() / 1000);
  const body: JwtPayload = {
    ...payload,
    iat,
    exp: iat + parseExpiresIn(expiresIn),
    iss: 'duekeeper',
    aud: 'duekeeper-web'
  };
  const head = b64url(JSON.stringify(HEADER));
  const claims = b64url(JSON.stringify(body));
  const data = `${head}.${claims}`;
  const sig = sign(data, secret).toString('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(tokenValue: string, secret: string): JwtPayload | null {
  const parts = tokenValue.split('.');
  if (parts.length !== 3) return null;
  const [head, claims, sig] = parts;
  let expected: Buffer;
  try {
    expected = sign(`${head}.${claims}`, secret);
  } catch {
    return null;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;
  if (payload.iss !== 'duekeeper' || payload.aud !== 'duekeeper-web') return null;
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
  return payload;
}

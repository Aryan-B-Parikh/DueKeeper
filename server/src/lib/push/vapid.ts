import { createECDH, createPrivateKey, sign as cryptoSign } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../../config/env';
import { createLogger } from '../logger';

const log = createLogger('vapid');

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const P256_SCALAR_BYTES = 32;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * OpenSSL returns EC scalars as minimal big-endian integers, so a private key
 * whose top byte(s) happen to be zero comes back shorter than 32 bytes (~1 key
 * in 256). RFC 7518 §6.2.2.1 requires the JWK "d" parameter to be exactly the
 * full coordinate length, and Node's createPrivateKey rejects anything else, so
 * those keys would fail at signing time and only in production. Left-pad.
 */
function padScalar(raw: Buffer): Buffer {
  if (raw.length === P256_SCALAR_BYTES) return raw;
  if (raw.length > P256_SCALAR_BYTES) throw new Error('EC scalar longer than P-256 field size');
  return Buffer.concat([Buffer.alloc(P256_SCALAR_BYTES - raw.length), raw]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(padScalar(ecdh.getPrivateKey()))
  };
}

let cached: VapidKeys | null = null;

function loadFromEnv(): VapidKeys | null {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  }
  return null;
}

function loadFromFile(): VapidKeys | null {
  if (config.isProd) return null;
  try {
    const path = resolve(config.dbPath, '..', 'vapid.json');
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) return parsed;
    }
  } catch {
    /* fall through to generation */
  }
  return null;
}

function persistDevKeys(keys: VapidKeys): void {
  if (config.isProd) return;
  try {
    const path = resolve(config.dbPath, '..', 'vapid.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(keys), 'utf8');
  } catch (err) {
    log.warn('Could not persist dev VAPID keys', err as Error);
  }
}

export function getVapidKeys(): VapidKeys | null {
  if (cached) return cached;
  const keys =
    loadFromEnv() ??
    loadFromFile() ??
    (() => {
      const generated = generateVapidKeys();
      log.warn('VAPID keys not configured; generated ephemeral dev keys. Browser push subscriptions will reset.');
      persistDevKeys(generated);
      return generated;
    })();
  cached = keys;
  return cached;
}

export function vapidSubject(): string {
  const match = /<([^>]+)>|(\S+@\S+)/.exec(config.emailFrom);
  const email = match?.[1] ?? match?.[2];
  return email ? `mailto:${email}` : 'mailto:admin@duekeeper.local';
}

interface JwkEc {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d?: string;
}

let cachedSigningKey: { publicKey: string; key: ReturnType<typeof createPrivateKey> } | null = null;

function vapidSigningKey(keys: VapidKeys): ReturnType<typeof createPrivateKey> {
  if (cachedSigningKey && cachedSigningKey.publicKey === keys.publicKey) return cachedSigningKey.key;

  const pubPoint = Buffer.from(keys.publicKey, 'base64url');
  if (pubPoint.length !== 65 || pubPoint[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  const privRaw = padScalar(Buffer.from(keys.privateKey, 'base64url'));

  const jwk: JwkEc = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pubPoint.subarray(1, 33)),
    y: b64url(pubPoint.subarray(33, 65)),
    d: b64url(privRaw)
  };
  const key = createPrivateKey({ key: jwk as unknown as Record<string, string>, format: 'jwk' });
  cachedSigningKey = { publicKey: keys.publicKey, key };
  return key;
}

export function buildVapidAuthorization(endpoint: string): string {
  const keys = getVapidKeys();
  if (!keys) throw new Error('VAPID keys unavailable');
  const origin = new URL(endpoint).origin;
  const privateKey = vapidSigningKey(keys);

  const claims = {
    aud: origin,
    // RFC 8292 §2 caps the token lifetime at 24h; 12h leaves room for clock skew.
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapidSubject()
  };
  const head = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = cryptoSign('SHA256', Buffer.from(`${head}.${body}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });

  return `vapid t=${head}.${body}.${b64url(signature)}, k=${keys.publicKey}`;
}

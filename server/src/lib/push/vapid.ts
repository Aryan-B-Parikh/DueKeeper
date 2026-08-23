import { createECDH, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../../config/env';
import { createLogger } from '../logger';

const log = createLogger('vapid');

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
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

export function buildVapidAuthorization(endpoint: string): string {
  const keys = getVapidKeys();
  if (!keys) throw new Error('VAPID keys unavailable');
  const origin = new URL(endpoint).origin;

  const pubPoint = Buffer.from(keys.publicKey, 'base64url');
  const privRaw = Buffer.from(keys.privateKey, 'base64url');
  const jwk: JwkEc = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pubPoint.subarray(1, 33)),
    y: b64url(pubPoint.subarray(33, 65)),
    d: b64url(privRaw)
  };
  const privateKey = createPrivateKey({ key: jwk as unknown as Record<string, string>, format: 'jwk' });

  const claims = {
    aud: origin,
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

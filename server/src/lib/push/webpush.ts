import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify as cryptoVerify
} from 'crypto';
import { buildVapidAuthorization } from './vapid';

export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const RS = 4096;

function uint16be(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}

function uint32be(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

export function encryptPayload(
  payload: string,
  subscription: { p256dh: string; auth: string }
): Buffer | null {
  try {
    const clientPublicKey = Buffer.from(subscription.p256dh, 'base64url');
    const authSecret = Buffer.from(subscription.auth, 'base64url');

    const ephemeral = createECDH('prime256v1');
    ephemeral.generateKeys();
    const ephemeralPub = ephemeral.getPublicKey();
    if (ephemeralPub.length !== 65 || ephemeralPub[0] !== 0x04) return null;

    const sharedSecret = ephemeral.computeSecret(clientPublicKey);
    const prkKey = hkdf(authSecret, sharedSecret, Buffer.from('Content-Encoding: auth\0'), 32);

    const cekSaltInfo = Buffer.concat([
      Buffer.from('Content-Encoding: aes128gcm\0'),
      Buffer.from('P-256'),
      uint16be(ephemeralPub.length),
      ephemeralPub
    ]);
    const nonceSaltInfo = Buffer.concat([
      Buffer.from('Content-Encoding: nonce\0'),
      Buffer.from('P-256'),
      uint16be(ephemeralPub.length),
      ephemeralPub
    ]);

    const salt = randomBytes(16);
    const cek = hkdf(prkKey, salt, cekSaltInfo, 16);
    const nonce = hkdf(prkKey, salt, nonceSaltInfo, 12);

    const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
    if (plaintext.length > RS - 17) return null;

    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.concat([salt, uint32be(RS), Buffer.from([ephemeralPub.length]), ephemeralPub]);
    return Buffer.concat([header, ciphertext]);
  } catch {
    return null;
  }
}

export function decryptPayload(body: Buffer, privateKeyRaw: Buffer, authSecret: Buffer): string | null {
  try {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idLen = body.readUInt8(20);
    const ephemeralPub = body.subarray(21, 21 + idLen);
    const ciphertext = body.subarray(21 + idLen);
    void rs;

    const receiver = createECDH('prime256v1');
    receiver.setPrivateKey(privateKeyRaw);
    const sharedSecret = receiver.computeSecret(ephemeralPub);

    const prkKey = hkdf(authSecret, sharedSecret, Buffer.from('Content-Encoding: auth\0'), 32);
    const cekSaltInfo = Buffer.concat([
      Buffer.from('Content-Encoding: aes128gcm\0'),
      Buffer.from('P-256'),
      uint16be(ephemeralPub.length),
      ephemeralPub
    ]);
    const nonceSaltInfo = Buffer.concat([
      Buffer.from('Content-Encoding: nonce\0'),
      Buffer.from('P-256'),
      uint16be(ephemeralPub.length),
      ephemeralPub
    ]);
    const cek = hkdf(prkKey, salt, cekSaltInfo, 16);
    const nonce = hkdf(prkKey, salt, nonceSaltInfo, 12);

    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const padded = Buffer.concat([decipher.update(data), decipher.final()]);
    if (padded[padded.length - 1] !== 2) return null;
    return padded.subarray(0, padded.length - 1).toString('utf8');
  } catch {
    return null;
  }
}

export interface PushSendResult {
  ok: boolean;
  status: number;
  gone: boolean;
}

export async function sendWebPush(
  subscription: PushSubscriptionDto,
  payload: { title: string; body: string; url?: string }
): Promise<PushSendResult> {
  const encrypted = encryptPayload(JSON.stringify(payload), subscription.keys);
  if (!encrypted) return { ok: false, status: 0, gone: false };

  let response: Response;
  try {
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: buildVapidAuthorization(subscription.endpoint),
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(3600),
        Urgency: 'high'
      },
      body: new Uint8Array(encrypted)
    });
  } catch {
    return { ok: false, status: 0, gone: false };
  }

  const gone = response.status === 404 || response.status === 410;
  return { ok: response.status >= 200 && response.status < 300, status: response.status, gone };
}

export function vapidSignatureVerifies(publicKeyB64url: string, signedData: string, signatureB64url: string): boolean {
  try {
    const point = Buffer.from(publicKeyB64url, 'base64url');
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url')
    };
    const keyObject = createPublicKey({ key: jwk as unknown as Record<string, string>, format: 'jwk' });
    return cryptoVerify(
      'SHA256',
      Buffer.from(signedData),
      { key: keyObject, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64url, 'base64url')
    );
  } catch {
    return false;
  }
}

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
import { config } from '../../config/env';

export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const RS = 4096;

function uint32be(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

/**
 * Node's hkdfSync performs Extract-then-Expand:
 *   HKDF(salt, ikm, info, L) = HKDF-Expand(HKDF-Extract(salt, ikm), info, L)
 *
 * Argument order is (digest, ikm, salt, info, length) — note that ikm comes
 * BEFORE salt, which is the opposite of how the RFCs write it. Getting these
 * two the wrong way round silently produces valid-looking but undecryptable
 * ciphertext, so this wrapper takes them in RFC order to keep call sites
 * readable against the spec.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

export interface DerivedKeys {
  ikm: Buffer;
  cek: Buffer;
  nonce: Buffer;
}

/**
 * RFC 8291 §3.3 key derivation, followed by the RFC 8188 "aes128gcm" content
 * coding key schedule.
 *
 *   key_info = "WebPush: info" || 0x00 || ua_public || as_public
 *   IKM      = HKDF(auth_secret, ecdh_secret, key_info, 32)
 *   CEK      = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, 16)
 *   NONCE    = HKDF(salt, IKM, "Content-Encoding: nonce"     || 0x00, 12)
 *
 * Exported so the unit tests can pin every intermediate against the official
 * test vector in RFC 8291 §5. Do not reorder the concatenations below: the
 * receiver's key comes first in key_info, and the aes128gcm info strings carry
 * no key material (that was the obsolete draft-04 "aesgcm" construction).
 */
export function deriveContentKeys(
  ecdhSecret: Buffer,
  authSecret: Buffer,
  uaPublic: Buffer,
  asPublic: Buffer,
  salt: Buffer
): DerivedKeys {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  return { ikm, cek, nonce };
}

/** Test-only overrides so the RFC 8291 §5 vector can be reproduced exactly. */
export interface EncryptOverrides {
  salt?: Buffer;
  senderPrivateKey?: Buffer;
  recordSize?: number;
}

export function encryptPayload(
  payload: string,
  subscription: { p256dh: string; auth: string },
  overrides?: EncryptOverrides
): Buffer | null {
  try {
    const clientPublicKey = Buffer.from(subscription.p256dh, 'base64url');
    const authSecret = Buffer.from(subscription.auth, 'base64url');
    if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 0x04) return null;

    const recordSize = overrides?.recordSize ?? RS;
    const ephemeral = createECDH('prime256v1');
    if (overrides?.senderPrivateKey) {
      ephemeral.setPrivateKey(overrides.senderPrivateKey);
    } else {
      ephemeral.generateKeys();
    }
    const ephemeralPub = ephemeral.getPublicKey();
    if (ephemeralPub.length !== 65 || ephemeralPub[0] !== 0x04) return null;

    const sharedSecret = ephemeral.computeSecret(clientPublicKey);
    const salt = overrides?.salt ?? randomBytes(16);
    if (salt.length !== 16) return null;

    const { cek, nonce } = deriveContentKeys(
      sharedSecret,
      authSecret,
      clientPublicKey,
      ephemeralPub,
      salt
    );

    // RFC 8188 §2: the final (here, only) record is delimited by 0x02, and the
    // whole record including the 16-byte GCM tag must fit within rs.
    const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
    if (plaintext.length + 16 > recordSize) return null;

    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.concat([
      salt,
      uint32be(recordSize),
      Buffer.from([ephemeralPub.length]),
      ephemeralPub
    ]);
    return Buffer.concat([header, ciphertext]);
  } catch {
    return null;
  }
}

export function decryptPayload(body: Buffer, privateKeyRaw: Buffer, authSecret: Buffer): string | null {
  try {
    if (body.length < 22) return null;
    const salt = body.subarray(0, 16);
    const recordSize = body.readUInt32BE(16);
    const idLen = body.readUInt8(20);
    if (idLen !== 65 || body.length < 21 + idLen + 16) return null;
    const ephemeralPub = body.subarray(21, 21 + idLen);
    const ciphertext = body.subarray(21 + idLen);
    if (ciphertext.length > recordSize) return null;

    const receiver = createECDH('prime256v1');
    receiver.setPrivateKey(privateKeyRaw);
    const sharedSecret = receiver.computeSecret(ephemeralPub);
    const receiverPub = receiver.getPublicKey();

    const { cek, nonce } = deriveContentKeys(
      sharedSecret,
      authSecret,
      receiverPub,
      ephemeralPub,
      salt
    );

    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const padded = Buffer.concat([decipher.update(data), decipher.final()]);
    if (padded.length === 0 || padded[padded.length - 1] !== 2) return null;
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
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), config.outboundFetchTimeoutMs);
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
        body: new Uint8Array(encrypted),
        signal: controller.signal
      });
    } finally {
      clearTimeout(t);
    }
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

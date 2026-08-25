import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'crypto';
import {
  deriveContentKeys,
  encryptPayload,
  decryptPayload,
  sendWebPush,
  vapidSignatureVerifies
} from '../lib/push/webpush';
import { generateVapidKeys, buildVapidAuthorization, getVapidKeys } from '../lib/push/vapid';

const b64 = (s: string): Buffer => Buffer.from(s, 'base64url');
const u64 = (b: Buffer): string => b.toString('base64url');

/**
 * Official test vector from RFC 8291 §5. These are fixed, externally published
 * constants — the whole point is that they were NOT produced by this codebase,
 * so they catch key-schedule regressions that a self-round-trip cannot. A
 * previous implementation swapped the auth_secret/ecdh_secret HKDF arguments and
 * omitted the "WebPush: info" step; every round-trip test still passed while no
 * real browser could decrypt a single notification.
 */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  recordSize: 4096,
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS' +
    '6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qu' +
    'lcy4a-fN'
};

describe('vapid keys', () => {
  it('generates valid P-256 uncompressed public points', () => {
    const keys = generateVapidKeys();
    const point = b64(keys.publicKey);
    assert.equal(point.length, 65);
    assert.equal(point[0], 0x04);
    assert.equal(b64(keys.privateKey).length, 32);
  });

  it('always emits a 32-byte private scalar, even when the top byte is zero', () => {
    // OpenSSL returns minimal big-endian integers, so ~1 key in 256 comes back
    // short; RFC 7518 §6.2.2.1 requires the full 32 bytes in the JWK "d".
    for (let i = 0; i < 512; i += 1) {
      assert.equal(b64(generateVapidKeys().privateKey).length, 32);
    }
  });

  it('builds an ES256-signed authorization header that verifies', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    const header = buildVapidAuthorization(endpoint);

    assert.ok(header.startsWith(`vapid t=`));
    const token = header.split('t=')[1].split(', k=')[0];
    const publicKey = header.split(', k=')[1];
    const [head, claims, signature] = token.split('.');

    assert.equal(vapidSignatureVerifies(publicKey, `${head}.${claims}`, signature), true);
    assert.equal(vapidSignatureVerifies(getVapidKeys()!.publicKey, `${head}.${claims}`, signature), true);
    assert.equal(vapidSignatureVerifies(generateVapidKeys().publicKey, `${head}.${claims}`, signature), false);
  });

  it('targets the audience at the endpoint origin', () => {
    const header = buildVapidAuthorization('https://push.example.com/send/x');
    const claims = JSON.parse(
      Buffer.from(header.split('t=')[1].split(', k=')[0].split('.')[1], 'base64url').toString()
    ) as { aud: string; exp: number; sub: string };
    assert.equal(claims.aud, 'https://push.example.com');
    assert.ok(claims.exp > Date.now() / 1000);
    // RFC 8292 §2 forbids lifetimes beyond 24h.
    assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600);
    assert.match(claims.sub, /^mailto:/);
  });
});

describe('rfc8291 §5 published test vector', () => {
  it('derives the exact ecdh_secret from the vector key pair', () => {
    const as = createECDH('prime256v1');
    as.setPrivateKey(b64(RFC8291.asPrivate));
    assert.equal(u64(as.getPublicKey()), RFC8291.asPublic);

    const ua = createECDH('prime256v1');
    ua.setPrivateKey(b64(RFC8291.uaPrivate));
    assert.equal(u64(ua.getPublicKey()), RFC8291.uaPublic);

    assert.equal(u64(as.computeSecret(b64(RFC8291.uaPublic))), RFC8291.ecdhSecret);
    // ECDH is symmetric; both sides must land on the same secret.
    assert.equal(u64(ua.computeSecret(b64(RFC8291.asPublic))), RFC8291.ecdhSecret);
  });

  it('derives the exact IKM, CEK and NONCE', () => {
    const derived = deriveContentKeys(
      b64(RFC8291.ecdhSecret),
      b64(RFC8291.authSecret),
      b64(RFC8291.uaPublic),
      b64(RFC8291.asPublic),
      b64(RFC8291.salt)
    );
    assert.equal(u64(derived.ikm), RFC8291.ikm);
    assert.equal(u64(derived.cek), RFC8291.cek);
    assert.equal(u64(derived.nonce), RFC8291.nonce);
  });

  it('is sensitive to swapping auth_secret and ecdh_secret', () => {
    // Guards the specific historical bug: HKDF still returns 32 plausible bytes
    // with the salt and IKM transposed, so only a comparison against a known
    // answer catches it.
    const swapped = deriveContentKeys(
      b64(RFC8291.authSecret),
      b64(RFC8291.ecdhSecret),
      b64(RFC8291.uaPublic),
      b64(RFC8291.asPublic),
      b64(RFC8291.salt)
    );
    assert.notEqual(u64(swapped.ikm), RFC8291.ikm);
  });

  it('is sensitive to reversing the key_info public key order', () => {
    const reversed = deriveContentKeys(
      b64(RFC8291.ecdhSecret),
      b64(RFC8291.authSecret),
      b64(RFC8291.asPublic),
      b64(RFC8291.uaPublic),
      b64(RFC8291.salt)
    );
    assert.notEqual(u64(reversed.ikm), RFC8291.ikm);
  });

  it('reproduces the published ciphertext byte for byte', () => {
    const encrypted = encryptPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      {
        salt: b64(RFC8291.salt),
        senderPrivateKey: b64(RFC8291.asPrivate),
        recordSize: RFC8291.recordSize
      }
    );
    assert.ok(encrypted);
    assert.equal(u64(encrypted), RFC8291.body);
  });

  it('decrypts the published ciphertext with the vector receiver key', () => {
    const decrypted = decryptPayload(
      b64(RFC8291.body),
      b64(RFC8291.uaPrivate),
      b64(RFC8291.authSecret)
    );
    assert.equal(decrypted, RFC8291.plaintext);
  });
});

describe('aes128gcm framing and round-trip', () => {
  function makeSubscriber(): { p256dh: string; auth: string; privateRaw: Buffer } {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: Buffer.from(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
      ).toString('base64url'),
      privateRaw: ecdh.getPrivateKey()
    };
  }

  it('produces salt|rs|idlen|pubkey framing and round-trips via receiver key', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('Hello DueKeeper', subscriber);
    assert.ok(encrypted);
    assert.equal(encrypted.subarray(0, 16).length, 16);
    assert.equal(encrypted.readUInt32BE(16), 4096);
    assert.equal(encrypted.readUInt8(20), 65);
    assert.equal(encrypted[21], 4);
    const decrypted = decryptPayload(encrypted, subscriber.privateRaw, b64(subscriber.auth));
    assert.equal(decrypted, 'Hello DueKeeper');
  });

  it('round-trips unicode JSON payloads', () => {
    const subscriber = makeSubscriber();
    const payload = JSON.stringify({ title: 'Exámen 📚 mañana', body: 'due 時間' });
    const encrypted = encryptPayload(payload, subscriber);
    assert.ok(encrypted);
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, b64(subscriber.auth)), payload);
  });

  it('unique salts produce unique ciphertexts', () => {
    const subscriber = makeSubscriber();
    const a = encryptPayload('same input', subscriber);
    const b = encryptPayload('same input', subscriber);
    assert.notDeepEqual(a, b);
  });

  it('accepts a payload that exactly fills the record', () => {
    const subscriber = makeSubscriber();
    // rs must cover plaintext + 1 delimiter byte + 16 tag bytes.
    const encrypted = encryptPayload('x'.repeat(4096 - 17), subscriber);
    assert.ok(encrypted);
    assert.equal(encrypted.length, 21 + 65 + 4096);
  });

  it('rejects payloads exceeding record size instead of emitting broken records', () => {
    const subscriber = makeSubscriber();
    assert.equal(encryptPayload('x'.repeat(4096 - 16), subscriber), null);
  });

  it('rejects malformed subscription keys', () => {
    const auth = Buffer.alloc(16, 7).toString('base64url');
    // Not a 65-byte point.
    assert.equal(encryptPayload('x', { p256dh: Buffer.alloc(32).toString('base64url'), auth }), null);
    // Right length, wrong point format byte (0x04 = uncompressed).
    const bad = Buffer.alloc(65, 1);
    assert.equal(encryptPayload('x', { p256dh: bad.toString('base64url'), auth }), null);
  });

  it('wrong auth secret fails the authentication tag check', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('secret message', subscriber)!;
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, Buffer.alloc(16, 9)), null);
  });

  it('tampered ciphertext fails decryption', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('secret message', subscriber)!;
    encrypted[encrypted.length - 1] ^= 0xff;
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, b64(subscriber.auth)), null);
  });

  it('rejects truncated and malformed bodies without throwing', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('secret message', subscriber)!;
    const auth = b64(subscriber.auth);
    assert.equal(decryptPayload(Buffer.alloc(0), subscriber.privateRaw, auth), null);
    assert.equal(decryptPayload(encrypted.subarray(0, 30), subscriber.privateRaw, auth), null);
    const badIdLen = Buffer.from(encrypted);
    badIdLen.writeUInt8(33, 20);
    assert.equal(decryptPayload(badIdLen, subscriber.privateRaw, auth), null);
  });
});

describe('sendWebPush guards', () => {
  it('fails fast without network when the subscription key is unusable', async () => {
    const result = await sendWebPush(
      {
        endpoint: 'https://push.invalid/no-network-expected',
        keys: {
          p256dh: Buffer.alloc(65).toString('base64url'),
          auth: Buffer.alloc(16).toString('base64url')
        }
      },
      { title: 't', body: 'b' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.gone, false);
  });
});

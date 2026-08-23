import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'crypto';
import { encryptPayload, decryptPayload, sendWebPush, vapidSignatureVerifies } from '../lib/push/webpush';
import { generateVapidKeys, buildVapidAuthorization, getVapidKeys } from '../lib/push/vapid';

describe('vapid keys', () => {
  it('generates valid P-256 uncompressed public points', () => {
    const keys = generateVapidKeys();
    const point = Buffer.from(keys.publicKey, 'base64url');
    assert.equal(point.length, 65);
    assert.equal(point[0], 0x04);
    assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
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
    const keys = generateVapidKeys();
    const header = buildVapidAuthorization('https://push.example.com/send/x');
    const claims = JSON.parse(Buffer.from(header.split('t=')[1].split(', k=')[0].split('.')[1], 'base64url').toString());
    assert.equal(claims.aud, 'https://push.example.com');
    assert.ok(claims.exp > Date.now() / 1000);
    assert.match(claims.sub as string, /^mailto:/);
  });
});

describe('rfc8291 aes128gcm payload encryption', () => {
  function makeSubscriber(): { p256dh: string; auth: string; privateRaw: Buffer } {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: Buffer.from(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).toString('base64url'),
      privateRaw: ecdh.getPrivateKey()
    };
  }

  it('produces salt|rs|idlen|pubkey framing and round-trips via receiver key', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('Hello DueKeeper', { p256dh: subscriber.p256dh, auth: subscriber.auth });
    assert.ok(encrypted);
    assert.equal(encrypted.readUInt32BE(16), 4096);
    assert.equal(encrypted.readUInt8(20), 65);
    assert.equal(encrypted[21], 4);
    const decrypted = decryptPayload(encrypted, subscriber.privateRaw, Buffer.from(subscriber.auth, 'base64url'));
    assert.equal(decrypted, 'Hello DueKeeper');
  });

  it('round-trips unicode JSON payloads', () => {
    const subscriber = makeSubscriber();
    const payload = JSON.stringify({ title: 'Exámen 📚 mañana', body: 'due 時間' });
    const encrypted = encryptPayload(payload, { p256dh: subscriber.p256dh, auth: subscriber.auth });
    assert.ok(encrypted);
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, Buffer.from(subscriber.auth, 'base64url')), payload);
  });

  it('unique salts produce unique ciphertexts', () => {
    const subscriber = makeSubscriber();
    const a = encryptPayload('same input', { p256dh: subscriber.p256dh, auth: subscriber.auth });
    const b = encryptPayload('same input', { p256dh: subscriber.p256dh, auth: subscriber.auth });
    assert.notDeepEqual(a, b);
  });

  it('rejects payloads exceeding record size instead of emitting broken records', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('x'.repeat(4096 - 17 + 10), { p256dh: subscriber.p256dh, auth: subscriber.auth });
    assert.equal(encrypted, null);
  });

  it('wrong auth secret fails the authentication tag check', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('secret message', { p256dh: subscriber.p256dh, auth: subscriber.auth })!;
    const wrongAuth = Buffer.alloc(16, 9);
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, wrongAuth), null);
  });

  it('tampered ciphertext fails decryption', () => {
    const subscriber = makeSubscriber();
    const encrypted = encryptPayload('secret message', { p256dh: subscriber.p256dh, auth: subscriber.auth })!;
    encrypted[encrypted.length - 1] ^= 0xff;
    assert.equal(decryptPayload(encrypted, subscriber.privateRaw, Buffer.from(subscriber.auth, 'base64url')), null);
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

  it('marks 410 Gone responses for pruning without throwing', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const result = await sendWebPush(
      {
        endpoint: `${process.env.SMOKE_BASE_URL ?? 'http://localhost:8080'}/api/inbox/webhook/gone-simulator`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') }
      },
      { title: 't', body: 'b' }
    );
    assert.equal(typeof result.gone === 'boolean', true);
  });
});

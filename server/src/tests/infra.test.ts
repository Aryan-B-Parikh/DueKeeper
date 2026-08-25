import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeStreamTicket,
  issueStreamTicket,
  resetStreamTickets,
  streamTicketCount
} from '../lib/streamTicket';
import { __loggerInternals } from '../lib/logger';
import { encryptSecret, decryptSecret, resetSecretboxCache } from '../lib/secretbox';
import { config } from '../config/env';

const { redact, redactString, safeStringify } = __loggerInternals;

describe('stream tickets', () => {
  it('issues a ticket that resolves to its user exactly once', () => {
    resetStreamTickets();
    const { ticket, expiresInSeconds } = issueStreamTicket('user-1');
    assert.equal(expiresInSeconds, 30);
    assert.equal(consumeStreamTicket(ticket), 'user-1');
    // Replay is the whole point of single use: a ticket captured from an access
    // log must already be spent.
    assert.equal(consumeStreamTicket(ticket), null);
    assert.equal(streamTicketCount(), 0);
  });

  it('rejects unknown, empty and oversized tickets', () => {
    resetStreamTickets();
    assert.equal(consumeStreamTicket(''), null);
    assert.equal(consumeStreamTicket('not-a-ticket'), null);
    assert.equal(consumeStreamTicket('x'.repeat(200)), null);
  });

  it('has enough entropy that guessing is not a strategy', () => {
    resetStreamTickets();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueStreamTicket('u').ticket);
    assert.equal(seen.size, 200);
    // 32 random bytes, base64url, no padding.
    for (const ticket of seen) assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    resetStreamTickets();
  });

  it('bounds memory by evicting the oldest tickets', () => {
    resetStreamTickets();
    for (let i = 0; i < 10_050; i += 1) issueStreamTicket('u');
    assert.ok(streamTicketCount() <= 10_000, `unbounded ticket store: ${streamTicketCount()}`);
    resetStreamTickets();
  });
});

describe('logger redaction', () => {
  it('redacts sensitive keys regardless of casing or separator', () => {
    const out = redact({
      refresh_token: 'abc',
      Authorization: 'Bearer xyz',
      apiKey: 'k',
      vapidPrivateKey: 'p',
      title: 'Assignment 3'
    }) as Record<string, unknown>;
    assert.equal(out.refresh_token, '[REDACTED]');
    assert.equal(out.Authorization, '[REDACTED]');
    assert.equal(out.apiKey, '[REDACTED]');
    assert.equal(out.vapidPrivateKey, '[REDACTED]');
    assert.equal(out.title, 'Assignment 3', 'ordinary fields must survive');
  });

  it('scrubs credentials embedded in strings', () => {
    // The inbox address is a bearer credential for writing a user's deadlines.
    assert.equal(
      redactString('delivered to deadline+9f8e7d6c5b4a3210@inbox.duekeeper.app'),
      'delivered to deadline+***@inbox.duekeeper.app'
    );
    assert.equal(
      redactString('GET /api/notifications/stream?ticket=SECRETVALUE&x=1'),
      'GET /api/notifications/stream?ticket=***&x=1'
    );
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlZGF0YQ';
    assert.equal(redactString(`auth failed for ${jwt}`), 'auth failed for [JWT]');
    assert.equal(redactString('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer ***');
  });

  it('survives a cycle instead of overflowing the stack', () => {
    // A logger that throws while reporting a failure converts a handled error
    // into a crash, so this is a availability property, not tidiness.
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    node.children = [{ parent: node }];
    const out = JSON.stringify(redact(node));
    assert.ok(out.includes('[Circular]'));
  });

  it('bounds depth, breadth and string length', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    assert.ok(JSON.stringify(redact(deep)).includes('[MaxDepth]'));

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 120; i += 1) wide[`k${i}`] = i;
    const redactedWide = redact(wide) as Record<string, unknown>;
    assert.equal(Object.keys(redactedWide).length, 51, '50 entries plus the truncation marker');

    const long = redactString('a'.repeat(5000));
    assert.ok(long.length < 2100 && long.endsWith('[truncated]'));
  });

  it('serializes values JSON.stringify would throw on', () => {
    const line = safeStringify({ level: 'error', msg: 'x', meta: redact({ big: 10n }) });
    assert.ok(line.includes('10n'));
    // And a value that cannot be serialized at all still yields a usable line.
    const hostile = { toJSON: () => { throw new Error('nope'); } };
    const fallback = safeStringify({ ts: 't', level: 'error', scope: 's', msg: 'm', meta: hostile });
    assert.ok(fallback.includes('"level":"error"'));
  });

  it('shapes errors with a redacted stack and cause chain', () => {
    const inner = new Error('token=SECRET rejected');
    const outer = new Error('wrapper', { cause: inner });
    const shaped = redact(outer) as Record<string, unknown>;
    assert.equal(shaped.name, 'Error');
    assert.equal(shaped.message, 'wrapper');
    const cause = shaped.cause as Record<string, unknown>;
    assert.equal(cause.message, 'token=*** rejected');
  });
});

describe('secretbox', () => {
  it('round-trips a secret', () => {
    const plaintext = 'ya29.a0AfB_refresh_token_value';
    assert.equal(decryptSecret(encryptSecret(plaintext)), plaintext);
  });

  it('rejects a tampered ciphertext', () => {
    const stored = encryptSecret('hello');
    const parts = stored.split('.');
    const blob = Buffer.from(parts[2], 'base64url');
    blob[0] ^= 0xff;
    assert.throws(() => decryptSecret(`${parts[0]}.${parts[1]}.${blob.toString('base64url')}`));
  });

  it('rejects a payload whose IV is not 12 bytes', () => {
    // createDecipheriv accepts a wrong-length GCM IV and silently changes counter
    // derivation instead of failing, and base64url decoding is lenient — so the
    // length check is the only thing standing between us and a confused decrypt.
    const stored = encryptSecret('hello');
    const parts = stored.split('.');
    const shortIv = Buffer.alloc(8).toString('base64url');
    assert.throws(
      () => decryptSecret(`${parts[0]}.${shortIv}.${parts[2]}`),
      /Invalid encrypted payload IV/
    );
  });

  it('rejects a truncated blob and an unknown version', () => {
    const stored = encryptSecret('hello');
    const parts = stored.split('.');
    assert.throws(
      () => decryptSecret(`${parts[0]}.${parts[1]}.${Buffer.alloc(4).toString('base64url')}`),
      /too short/
    );
    assert.throws(() => decryptSecret(`v9.${parts[1]}.${parts[2]}`), /Unsupported/);
    assert.throws(() => decryptSecret('only.two'), /format/);
  });
});

/**
 * Key rotation is the half of the encryption story that only matters once — on
 * the day the key changes — which is exactly why it needs a test. A rotation
 * that silently fails is discovered when a user's Google sync breaks and the
 * only remedy left is a reconnect.
 */
describe('secretbox key rotation', () => {
  const KEY_A = Buffer.alloc(32, 0xa1).toString('base64');
  const KEY_B = Buffer.alloc(32, 0xb2).toString('base64');

  const savedKey = config.encryptionKey;
  const savedPrevious = config.previousEncryptionKeys;

  function withKeys<T>(current: string, previous: string[], fn: () => T): T {
    config.encryptionKey = current;
    config.previousEncryptionKeys = previous;
    resetSecretboxCache();
    try {
      return fn();
    } finally {
      config.encryptionKey = savedKey;
      config.previousEncryptionKeys = savedPrevious;
      resetSecretboxCache();
    }
  }

  it('still reads rows written under the previous key, and writes under the new one', () => {
    const underOldKey = withKeys(KEY_A, [], () => encryptSecret('ya29.google-refresh-token'));

    // The point of the rotation list: nothing re-encrypts the stored Google
    // refresh token until the user reconnects, so the old key has to stay
    // readable or sync breaks for every already-connected account.
    const afterRotation = withKeys(KEY_B, [KEY_A], () => {
      assert.equal(decryptSecret(underOldKey), 'ya29.google-refresh-token');
      // New writes use the current key.
      const fresh = encryptSecret('written-after-rotation');
      assert.equal(decryptSecret(fresh), 'written-after-rotation');
      return fresh;
    });

    withKeys(KEY_B, [], () => {
      // A row written after the rotation needs only the current key…
      assert.equal(decryptSecret(afterRotation), 'written-after-rotation');
      // …while dropping the old key genuinely makes the old row unreadable,
      // which is why config/env.ts refuses to start on a malformed entry in the
      // rotation list rather than skipping past it.
      assert.throws(() => decryptSecret(underOldKey));
    });
  });

  it('says so loudly when a previous key is not a 32-byte base64 value', () => {
    const underOldKey = withKeys(KEY_A, [], () => encryptSecret('secret'));
    const errors: string[] = [];
    const realError = console.error;
    console.error = (line: unknown) => {
      errors.push(String(line));
    };
    try {
      // A truncated paste next to a good key. The bad entry must not take the
      // good one down with it, and it must not be discarded in silence: a
      // silently dropped key is a row that can no longer be decrypted with no
      // indication why. Production refuses to boot on this; development logs it.
      withKeys(KEY_B, ['not-base64-at-all!!', KEY_A], () => {
        assert.equal(decryptSecret(underOldKey), 'secret');
      });
    } finally {
      console.error = realError;
    }
    assert.ok(
      errors.some((line) => line.includes('PREVIOUS_ENCRYPTION_KEYS[0]')),
      `a malformed rotation key must be reported; logged: ${JSON.stringify(errors)}`
    );
  });
});

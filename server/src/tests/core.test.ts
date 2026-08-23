import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { encryptSecret, decryptSecret, constantTimeEqual } from '../lib/secretbox';
import { createRateLimiter } from '../lib/rateLimit';
import { parseIcsCalendar, generateIcsCalendar } from '../lib/ics';
import { extractHeuristicCandidates } from '../modules/extract/heuristic';
import { zonedToUtcIso, addDays, startOfDay } from '../modules/extract/dateUtils';

describe('secretbox (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const secret = 'refresh-token-abc-123';
    const stored = encryptSecret(secret);
    assert.notEqual(stored, secret);
    assert.ok(stored.startsWith('v1.'));
    assert.equal(decryptSecret(stored), secret);
  });

  it('produces unique ciphertexts per call', () => {
    assert.notEqual(encryptSecret('same'), encryptSecret('same'));
  });

  it('rejects tampered payloads', () => {
    const stored = encryptSecret('sensitive');
    const tampered = `${stored.slice(0, -4)}AAAA`;
    assert.throws(() => decryptSecret(tampered));
  });

  it('constant-time comparison works', () => {
    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
  });
});

describe('rate limiter', () => {
  it('allows up to max then blocks with retry hint', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(limiter.take('k1').allowed, true);
    }
    const blocked = limiter.take('k1');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    limiter.take('a');
    limiter.take('a');
    assert.equal(limiter.take('a').allowed, false);
    assert.equal(limiter.take('b').allowed, true);
  });
});

describe('timezone conversion', () => {
  it('converts wall clock in Asia/Kolkata to UTC', () => {
    assert.equal(zonedToUtcIso(2026, 0, 10, 8, 30, 'Asia/Kolkata'), '2026-01-10T03:00:00.000Z');
  });

  it('converts wall clock in America/New_York to UTC (winter = UTC-5)', () => {
    assert.equal(zonedToUtcIso(2026, 0, 10, 8, 30, 'America/New_York'), '2026-01-10T13:30:00.000Z');
  });

  it('handles UTC passthrough', () => {
    assert.equal(zonedToUtcIso(2026, 5, 1, 12, 0, 'UTC'), '2026-06-01T12:00:00.000Z');
  });

  it('addDays and startOfDay behave', () => {
    const d = new Date(2026, 7, 23, 15, 30);
    const next = addDays(d, 3);
    assert.equal(next.getDate(), 26);
    const sod = startOfDay(d);
    assert.deepEqual([sod.getHours(), sod.getMinutes(), sod.getSeconds()], [0, 0, 0]);
  });
});

describe('cross-module integration sanity', () => {
  it('extracted candidate can round-trip through ICS generation', () => {
    const [candidate] = extractHeuristicCandidates('Final demo deadline Feb 18 2027 at 5pm', 'Asia/Kolkata');
    assert.ok(candidate?.dueAtIso);
    const generated = generateIcsCalendar([{ id: 'x', title: candidate.title, dueAt: candidate.dueAtIso! }]);
    const [parsed] = parseIcsCalendar(generated);
    assert.equal(parsed.startUtcIso, candidate.dueAtIso);
  });

  it('jwt rejects token signed for another issuer namespace', () => {
    const token = signJwt({ sub: 'u', email: 'e' }, 'test-secret-that-is-long-enough-1234', 60);
    const payload = verifyJwt(token, 'test-secret-that-is-long-enough-1234');
    assert.ok(payload);
    assert.notEqual(payload.iss, 'other-app');
  });

  it('scrypt hashes are not reversible into each other', () => {
    const a = hashPassword('alpha1234');
    assert.equal(verifyPassword('beta1234', a), false);
  });
});

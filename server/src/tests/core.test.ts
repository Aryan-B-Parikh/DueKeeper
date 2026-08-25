import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { encryptSecret, decryptSecret, constantTimeEqual } from '../lib/secretbox';
import { createRateLimiter } from '../lib/rateLimit';
import { parseIcsCalendar, generateIcsCalendar } from '../lib/ics';
import { extractHeuristicCandidates } from '../modules/extract/heuristic';
import {
  zonedToUtcIso,
  zonedToUtc,
  addDays,
  startOfDay,
  civilDateInZone,
  addCivilDays,
  isValidCivilDate,
  tzOffsetMinutes
} from '../modules/extract/dateUtils';
import { validateInstant, isValidTimezone } from '../lib/datetimeValidation';

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

  // The single-pass version of this conversion sampled the zone's offset at
  // "naive interpreted as UTC", which is the wrong instant within a day of a DST
  // transition. Each case below is one the single-pass code got wrong by an hour.
  it('applies the post-transition offset on the day the clocks go forward', () => {
    // 2026-03-08 is spring-forward in the US. 09:00 local is EDT (UTC-4), so
    // 13:00Z. Sampling at 09:00Z would still read EST and answer 14:00Z.
    assert.equal(zonedToUtcIso(2026, 2, 8, 9, 0, 'America/New_York'), '2026-03-08T13:00:00.000Z');
  });

  it('applies the pre-transition offset on the day the clocks go back', () => {
    // 2026-11-01 is fall-back. 09:00 local is EST (UTC-5) -> 14:00Z.
    assert.equal(zonedToUtcIso(2026, 10, 1, 9, 0, 'America/New_York'), '2026-11-01T14:00:00.000Z');
  });

  it('handles a southern-hemisphere transition in the opposite direction', () => {
    // Australia/Sydney goes back on 2026-04-05: 09:00 local is AEST (UTC+10).
    assert.equal(zonedToUtcIso(2026, 3, 5, 9, 0, 'Australia/Sydney'), '2026-04-04T23:00:00.000Z');
  });

  it('reports a wall time that does not exist and never returns an earlier instant', () => {
    // 02:30 on 2026-03-08 in New York is skipped: the clock jumps 02:00 -> 03:00.
    const gap = zonedToUtc(2026, 2, 8, 2, 30, 'America/New_York');
    assert.ok(gap, 'conversion should still produce a usable instant');
    assert.equal(gap!.adjusted, true, 'the gap must be reported, not silently absorbed');
    // 03:30 EDT is the first real instant at that wall reading.
    assert.equal(gap!.iso, '2026-03-08T07:30:00.000Z');
    // A real time on the same day must not be flagged.
    assert.equal(zonedToUtc(2026, 2, 8, 9, 0, 'America/New_York')!.adjusted, false);
  });

  it('resolves an ambiguous repeated hour to the earlier occurrence', () => {
    // 01:30 on 2026-11-01 in New York happens twice. Earlier is the safe choice
    // for a deadline product: a reminder fires early, never late.
    const ambiguous = zonedToUtc(2026, 10, 1, 1, 30, 'America/New_York');
    assert.equal(ambiguous!.adjusted, false);
    assert.equal(ambiguous!.iso, '2026-11-01T05:30:00.000Z');
  });

  it('rejects an unknown zone instead of falling back to the server zone', () => {
    assert.equal(zonedToUtcIso(2026, 0, 1, 12, 0, 'Mars/Olympus_Mons'), null);
    assert.equal(tzOffsetMinutes('Mars/Olympus_Mons', new Date()), null);
  });

  it('reads half-hour and three-quarter-hour offsets correctly', () => {
    assert.equal(zonedToUtcIso(2026, 0, 10, 12, 0, 'Asia/Kathmandu'), '2026-01-10T06:15:00.000Z');
    assert.equal(zonedToUtcIso(2026, 0, 10, 12, 0, 'Australia/Eucla'), '2026-01-10T03:15:00.000Z');
  });
});

describe('civil dates (relative parsing in the user zone)', () => {
  it('reads the calendar date of a zone, not the server', () => {
    // 2026-08-24T23:30Z: already the 25th in Kolkata (UTC+5:30), still the 24th
    // in New York. Reading either with local getters would give the server's
    // answer instead of the user's.
    const at = new Date('2026-08-24T23:30:00.000Z');
    assert.deepEqual(
      (({ year, month, day }) => ({ year, month, day }))(civilDateInZone('Asia/Kolkata', at)),
      { year: 2026, month: 7, day: 25 }
    );
    assert.deepEqual(
      (({ year, month, day }) => ({ year, month, day }))(civilDateInZone('America/New_York', at)),
      { year: 2026, month: 7, day: 24 }
    );
  });

  it('reports the weekday of the zone-local date', () => {
    // 2026-08-24 is a Monday; 2026-08-25 a Tuesday.
    assert.equal(civilDateInZone('America/New_York', new Date('2026-08-24T23:30:00.000Z')).weekday, 1);
    assert.equal(civilDateInZone('Asia/Kolkata', new Date('2026-08-24T23:30:00.000Z')).weekday, 2);
  });

  it('rolls over months and years exactly, with no DST involvement', () => {
    assert.deepEqual(addCivilDays({ year: 2026, month: 11, day: 30, weekday: 3 }, 2), {
      year: 2027,
      month: 0,
      day: 1,
      weekday: 5
    });
    // Across a spring-forward boundary: adding a day is still exactly one day.
    assert.deepEqual(addCivilDays({ year: 2026, month: 2, day: 7, weekday: 6 }, 1), {
      year: 2026,
      month: 2,
      day: 8,
      weekday: 0
    });
  });

  it('rejects dates the Date constructor would silently roll forward', () => {
    assert.equal(isValidCivilDate(2026, 1, 31), false, 'Feb 31 must not become Mar 3');
    assert.equal(isValidCivilDate(2026, 1, 29), false, '2026 is not a leap year');
    assert.equal(isValidCivilDate(2024, 1, 29), true, '2024 is');
    assert.equal(isValidCivilDate(2026, 12, 1), false, 'month 12 is out of range');
    assert.equal(isValidCivilDate(2026, 3, 31), false, 'April has 30 days');
    assert.equal(isValidCivilDate(2026, 7, 24), true);
  });
});

describe('instant and timezone validation', () => {
  it('accepts offset-bearing ISO instants', () => {
    assert.equal(validateInstant('2026-08-24T15:00:00Z'), null);
    assert.equal(validateInstant('2026-08-24T15:00:00.123Z'), null);
    assert.equal(validateInstant('2026-08-24T15:00+05:30'), null);
    assert.equal(validateInstant('2026-08-24T15:00:00-0800'), null);
  });

  it('rejects a naive date-time, because ECMAScript would read it in the server zone', () => {
    assert.equal(validateInstant('2026-08-24T15:00:00')?.code, 'OFFSET');
    assert.equal(validateInstant('2026-08-24')?.code, 'OFFSET');
  });

  it('rejects impossible calendar dates that Date.parse would roll over', () => {
    assert.equal(validateInstant('2026-02-31T10:00:00Z')?.code, 'CALENDAR');
    assert.equal(validateInstant('2026-99-01T10:00:00Z')?.code, 'CALENDAR');
    assert.equal(validateInstant('2026-08-24T25:00:00Z')?.code, 'CALENDAR');
  });

  it('rejects instants far outside any plausible deadline', () => {
    assert.equal(validateInstant('9999-01-01T00:00:00Z')?.code, 'RANGE');
  });

  it('rejects free-text and fixed-offset values as timezones', () => {
    assert.equal(isValidTimezone('Asia/Kolkata'), true);
    assert.equal(isValidTimezone('UTC'), true);
    assert.equal(isValidTimezone('America/Argentina/Buenos_Aires'), true);
    assert.equal(isValidTimezone('+05:30'), false);
    assert.equal(isValidTimezone('EST'), false, 'bare abbreviations are ambiguous');
    assert.equal(isValidTimezone('Mars/Olympus_Mons'), false);
    assert.equal(isValidTimezone('x'.repeat(200)), false);
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

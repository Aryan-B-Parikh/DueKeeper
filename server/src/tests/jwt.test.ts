import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../lib/jwt';

const SECRET = 'test-secret-that-is-long-enough-1234';

describe('jwt', () => {
  it('round-trips a valid token', () => {
    const token = signJwt({ sub: 'user-1', email: 'a@b.c' }, SECRET, 3600);
    const payload = verifyJwt(token, SECRET);
    assert.ok(payload);
    assert.equal(payload.sub, 'user-1');
    assert.equal(payload.email, 'a@b.c');
    assert.equal(payload.iss, 'duekeeper');
    assert.equal(payload.aud, 'duekeeper-web');
  });

  it('rejects tampered signatures', () => {
    const token = signJwt({ sub: 'user-1', email: 'a@b.c' }, SECRET, 3600);
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
    assert.equal(verifyJwt(forged, SECRET), null);
  });

  it('rejects wrong secret', () => {
    const token = signJwt({ sub: 'u', email: 'e' }, SECRET, 3600);
    assert.equal(verifyJwt(token, 'another-secret-that-is-long-enough'), null);
  });

  it('rejects expired tokens', () => {
    const token = signJwt({ sub: 'u', email: 'e' }, SECRET, -10);
    assert.equal(verifyJwt(token, SECRET), null);
  });

  it('rejects malformed tokens', () => {
    assert.equal(verifyJwt('abc', SECRET), null);
    assert.equal(verifyJwt('a.b.c', SECRET), null);
    assert.equal(verifyJwt('', SECRET), null);
  });

  it('parses expiry suffixes', () => {
    const token = signJwt({ sub: 'u', email: 'e' }, SECRET, '7d');
    const payload = verifyJwt(token, SECRET);
    assert.ok(payload);
    assert.ok(payload.exp - payload.iat >= 86399 * 7 && payload.exp - payload.iat <= 86401 * 7);
  });
});

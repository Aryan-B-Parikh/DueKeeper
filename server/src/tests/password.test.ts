import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/password';

describe('password hashing', () => {
  it('verifies the correct password', () => {
    const hash = hashPassword('Passw0rd!42');
    assert.equal(verifyPassword('Passw0rd!42', hash), true);
  });

  it('rejects incorrect passwords', () => {
    const hash = hashPassword('Passw0rd!42');
    assert.equal(verifyPassword('Passw0rd!43', hash), false);
    assert.equal(verifyPassword('', hash), false);
  });

  it('produces unique salts per hash', () => {
    const a = hashPassword('same-password1');
    const b = hashPassword('same-password1');
    assert.notEqual(a, b);
  });

  it('handles unicode passwords via NFKC normalization', () => {
    const hash = hashPassword('café\u0301 Passw0rd');
    assert.equal(verifyPassword('café\u0301 Passw0rd', hash), true);
  });

  it('returns false for malformed stored hashes', () => {
    assert.equal(verifyPassword('x', 'garbage'), false);
    assert.equal(verifyPassword('x', 'bcrypt$10$abcdef'), false);
  });
});

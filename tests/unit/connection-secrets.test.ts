import { describe, expect, it } from 'vitest';
import { decryptConnectionSecret, encryptConnectionSecret } from '@scaleinsyght/connectors';

describe('encrypted connector credentials', () => {
  it('connection_secret_roundtrips_and_authentication_fails_on_tamper', () => {
    const key = Buffer.alloc(32, 17).toString('base64');
    const secret = { host: '127.0.0.1', port: 5432, database: 'test_source', username: 'read_only', password: 'synthetic-only' };
    const encrypted = encryptConnectionSecret(secret, key);
    expect(encrypted.ciphertext).not.toContain(secret.password);
    expect(decryptConnectionSecret(encrypted, key)).toEqual(secret);
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
    expect(() => decryptConnectionSecret(tampered, key)).toThrow('connection_secret_authentication_failed');
  });

  it('connection_secret_requires_a_32_byte_key', () => {
    expect(() => encryptConnectionSecret({ password: 'synthetic-only' }, Buffer.alloc(8).toString('base64')))
      .toThrow('connection_secret_key_must_be_32_bytes');
  });
});

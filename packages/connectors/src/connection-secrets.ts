import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedConnectionSecret {
  version: 1;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

function decodeKey(key: string | undefined): Buffer {
  if (!key) throw new Error('connection_secret_key_required');
  const decoded = Buffer.from(key, 'base64');
  if (decoded.byteLength !== 32) throw new Error('connection_secret_key_must_be_32_bytes');
  return decoded;
}

export function encryptConnectionSecret(secret: Record<string, unknown>, key = process.env.CONNECTION_SECRET_KEY): EncryptedConnectionSecret {
  const encryptionKey = decodeKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return { version: 1, ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptConnectionSecret<T extends Record<string, unknown> = Record<string, unknown>>(
  encrypted: EncryptedConnectionSecret,
  key = process.env.CONNECTION_SECRET_KEY,
): T {
  if (encrypted.version !== 1) throw new Error('connection_secret_version_unsupported');
  const encryptionKey = decodeKey(key);
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(encrypted.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error('connection_secret_authentication_failed');
  }
}

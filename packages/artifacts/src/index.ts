import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const keyVersion = 1;
const nonceLength = 12;
const tagLength = 16;
const artifactIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredArtifact {
  artifactId: string;
  keySalt: Buffer;
  contentSha256: Buffer;
  encryptedSize: number;
  keyVersion: number;
}

export class EncryptedArtifactStore {
  readonly root: string;
  private readonly masterKey: Buffer;

  constructor(root: string, masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('ARTIFACT_MASTER_KEY must decode to exactly 32 bytes');
    this.root = resolve(root);
    this.masterKey = Buffer.from(masterKey);
  }

  tenantDirectory(tenantId: string): string {
    return createHmac('sha256', this.masterKey).update(`tenant:${tenantId}`).digest('hex');
  }

  async put(tenantId: string, plaintext: Buffer): Promise<StoredArtifact> {
    if (!tenantId.trim()) throw new Error('tenant_id_required');
    const artifactId = randomUUID();
    const keySalt = randomBytes(32);
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv('aes-256-gcm', this.artifactKey(tenantId, keySalt), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encoded = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    const directory = join(this.root, this.tenantDirectory(tenantId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = join(directory, `.${artifactId}.${randomUUID()}.tmp`);
    const finalPath = join(directory, `${artifactId}.enc`);
    try {
      await writeFile(tempPath, encoded, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, finalPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return {
      artifactId,
      keySalt,
      contentSha256: createHash('sha256').update(plaintext).digest(),
      encryptedSize: encoded.length,
      keyVersion,
    };
  }

  async read(tenantId: string, artifactId: string, keySalt: Buffer): Promise<Buffer> {
    const filePath = this.filePath(tenantId, artifactId);
    const encoded = await readFile(filePath);
    if (encoded.length < nonceLength + tagLength) throw new Error('artifact_integrity_failed');
    const nonce = encoded.subarray(0, nonceLength);
    const tag = encoded.subarray(nonceLength, nonceLength + tagLength);
    const ciphertext = encoded.subarray(nonceLength + tagLength);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.artifactKey(tenantId, keySalt), nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('artifact_integrity_failed');
    }
  }

  async remove(tenantId: string, artifactId: string): Promise<void> {
    await rm(this.filePath(tenantId, artifactId), { force: true });
  }

  private tenantKey(tenantId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.from(tenantId), Buffer.from('scale-insyght/workbook/v1'), 32));
  }

  private artifactKey(tenantId: string, keySalt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', this.tenantKey(tenantId), keySalt, Buffer.from('workbook-artifact-key/v1'), 32));
  }

  private filePath(tenantId: string, artifactId: string): string {
    if (!artifactIdPattern.test(artifactId)) throw new Error('invalid_artifact_id');
    return join(this.root, this.tenantDirectory(tenantId), `${artifactId}.enc`);
  }
}

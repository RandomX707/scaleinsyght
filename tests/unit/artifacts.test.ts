import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedArtifactStore, artifactVolumePath } from '@scaleinsyght/artifacts';

const roots: string[] = [];
async function makeStore(): Promise<EncryptedArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), 'si-artifacts-'));
  roots.push(root);
  return new EncryptedArtifactStore(root, Buffer.alloc(32, 7));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tenant encrypted workbook artifacts', () => {
  it('c7_workbook_bytes_are_encrypted_at_rest_and_roundtrip', async () => {
    const store = await makeStore();
    const bytes = Buffer.from('synthetic workbook contents only');
    const artifact = await store.put('golden-tenant-north', bytes);
    const tenantPath = join(store.root, store.tenantDirectory('golden-tenant-north'));
    const fileName = (await readdir(tenantPath))[0]!;
    const ciphertext = await readFile(join(tenantPath, fileName));
    expect(ciphertext.includes(bytes)).toBe(false);
    expect(await store.read('golden-tenant-north', artifact.artifactId, artifact.keySalt)).toEqual(bytes);
  });

  it('c7_workbook_ciphertext_cannot_be_opened_by_another_tenant', async () => {
    const store = await makeStore();
    const artifact = await store.put('golden-tenant-north', Buffer.from('north synthetic workbook'));
    await expect(store.read('golden-tenant-south', artifact.artifactId, artifact.keySalt)).rejects.toThrow();
  });

  it('c7_connector_removal_deletes_workbook_ciphertext', async () => {
    const store = await makeStore();
    const artifact = await store.put('golden-tenant-north', Buffer.from('synthetic workbook'));
    await store.remove('golden-tenant-north', artifact.artifactId);
    await expect(store.read('golden-tenant-north', artifact.artifactId, artifact.keySalt)).rejects.toThrow();
  });

  it('c7_tampered_workbook_ciphertext_is_rejected', async () => {
    const store = await makeStore();
    const artifact = await store.put('golden-tenant-north', Buffer.from('synthetic workbook'));
    const tenantPath = join(store.root, store.tenantDirectory('golden-tenant-north'));
    const fileName = (await readdir(tenantPath))[0]!;
    const ciphertext = await readFile(join(tenantPath, fileName));
    ciphertext[ciphertext.length - 1] ^= 0xff;
    await (await import('node:fs/promises')).writeFile(join(tenantPath, fileName), ciphertext);
    await expect(store.read('golden-tenant-north', artifact.artifactId, artifact.keySalt)).rejects.toThrow();
  });

  it('c7_missing_artifact_file_is_reported_by_name_not_as_a_file_system_error', async () => {
    const store = await makeStore();
    const artifact = await store.put('golden-tenant-north', Buffer.from('synthetic'));
    await rm(join(store.root, store.tenantDirectory('golden-tenant-north')), { recursive: true });
    await expect(store.read('golden-tenant-north', artifact.artifactId, artifact.keySalt)).rejects.toThrow('artifact_file_missing');
  });
});

describe('artifact volume location', () => {
  it('requires an absolute ARTIFACT_VOLUME_PATH so every worktree reads the same volume', () => {
    expect(artifactVolumePath('/var/lib/scaleinsyght/artifacts')).toBe('/var/lib/scaleinsyght/artifacts');
    expect(() => artifactVolumePath('.local/artifacts')).toThrow('ARTIFACT_VOLUME_PATH must be an absolute path that every worktree and process shares');
    expect(() => artifactVolumePath('.local/artifacts')).toThrow('".local/artifacts"');
    expect(() => artifactVolumePath(undefined)).toThrow('got nothing');
    expect(() => artifactVolumePath('  ')).toThrow('ARTIFACT_VOLUME_PATH must be an absolute path');
  });
});

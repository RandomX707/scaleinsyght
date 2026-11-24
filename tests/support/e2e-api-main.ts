import { config } from 'dotenv';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { buildTestServer } from './test-api.js';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const artifactMasterKey = process.env.ARTIFACT_MASTER_KEY;
if (!artifactMasterKey) throw new Error('ARTIFACT_MASTER_KEY is required for E2E tests');
const server = await buildTestServer({
  pool,
  sessionSecret: process.env.SESSION_SECRET ?? '',
  artifactStore: new EncryptedArtifactStore(resolve(process.env.ARTIFACT_VOLUME_PATH ?? '.local/e2e-artifacts'), Buffer.from(artifactMasterKey, 'base64')),
});
await server.listen({ host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3300) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  await server.close();
  await pool.end();
  process.exit(0);
});

import { config } from 'dotenv';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { resolve } from 'node:path';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const artifactMasterKey=process.env.ARTIFACT_MASTER_KEY;
if(!artifactMasterKey)throw new Error('ARTIFACT_MASTER_KEY is required; set it in .env before starting the API');
const artifactStore=new EncryptedArtifactStore(resolve(process.env.ARTIFACT_VOLUME_PATH??'.local/artifacts'),Buffer.from(artifactMasterKey,'base64'));
const server=await buildServer({pool,sessionSecret:process.env.SESSION_SECRET??'',artifactStore});
const port=Number(process.env.API_PORT??3000);
await server.listen({host:process.env.API_HOST??'127.0.0.1',port});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await server.close();await pool.end();process.exit(0);});

import { config } from 'dotenv';
import { resolve } from 'node:path';
config({path:resolve('.env')});
const database=new URL(process.env.DATABASE_URL_WORKER??'');if(!database.hostname)throw new Error('DATABASE_URL_WORKER is required for the testbed worker.');database.pathname='/si_test';
process.env.DATABASE_URL_WORKER=database.toString();process.env.WORKER_HEALTH_PORT='3311';process.env.WORKER_HEALTH_HOST='127.0.0.1';
await import('../apps/worker/src/main.js');

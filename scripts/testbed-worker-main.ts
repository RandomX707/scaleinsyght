import { config } from 'dotenv';
import { resolve } from 'node:path';
config({path:resolve('.env')});
// Tests never pay for the model (decision 69): replay recordings unless MODEL_REPLAY=record is set explicitly.
process.env.MODEL_REPLAY??='replay';
const database=new URL(process.env.DATABASE_URL_WORKER??'');if(!database.hostname)throw new Error('DATABASE_URL_WORKER is required for the testbed worker.');database.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;
process.env.DATABASE_URL_WORKER=database.toString();process.env.WORKER_HEALTH_PORT??='3311';process.env.WORKER_HEALTH_HOST??='127.0.0.1';
await import('../apps/worker/src/main.js');

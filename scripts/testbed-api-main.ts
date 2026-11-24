import { config } from 'dotenv';
import { resolve } from 'node:path';
config({path:resolve('.env')});
const database=new URL(process.env.DATABASE_URL??'');if(!database.hostname)throw new Error('DATABASE_URL is required for the testbed API.');database.pathname='/si_test';
process.env.DATABASE_URL=database.toString();process.env.API_PORT='3310';process.env.API_HOST='127.0.0.1';
process.env.PUBLIC_APP_URL='http://127.0.0.1:4184';
await import('../apps/api/src/main.js');

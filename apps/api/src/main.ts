import { config } from 'dotenv';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const golden=JSON.parse(readFileSync(new URL('../../../tests/golden/phase0.json',import.meta.url),'utf8')) as {users:Array<{tenantId:string;email:string}>};
const server=await buildServer({pool,sessionSecret:process.env.SESSION_SECRET??'',goldenAccounts:golden.users.map(user=>({tenantId:user.tenantId,email:user.email}))});
const port=Number(process.env.API_PORT??3000);
await server.listen({host:'127.0.0.1',port});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await server.close();await pool.end();process.exit(0);});

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withRunTenant } from '@scaleinsyght/db';
import { claimNextStep, completeStep } from '@scaleinsyght/runner';

config({path:fileURLToPath(new URL('../../../.env',import.meta.url))});
const golden=JSON.parse(readFileSync(new URL('../../../tests/golden/phase0.json',import.meta.url),'utf8')) as {scriptedRun:{resultRefs:string[]}};
const pool=new Pool({connectionString:process.env.DATABASE_URL_WORKER});
const workerId=`worker-${process.pid}`;
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
while(!stopping){
 try{
  const claim=await claimNextStep(pool,workerId,30_000);
  if(!claim){await new Promise(resolve=>setTimeout(resolve,500));continue;}
  const order=await withRunTenant(pool,claim.runId,async(client)=>{
   const result=await client.query<{step_order:number}>('SELECT step_order FROM runs.steps WHERE run_id=$1 AND step_id=$2',[claim.runId,claim.stepId]);
   return result.rows[0]?.step_order??0;
  });
  const ref=golden.scriptedRun.resultRefs[order-1];
  if(!ref)throw new Error(`No synthetic golden result reference for step order ${order}`);
  await completeStep(pool,claim,{resultRef:ref});
 }catch(error){console.error('Worker iteration failed:',error);process.exitCode=1;stopping=true;}
}
await pool.end();

import { config } from 'dotenv';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { withRunTenant } from '@scaleinsyght/db';
import { claimNextStep, completeStep } from '@scaleinsyght/runner';

config({path:fileURLToPath(new URL('../../.env',import.meta.url))});
const mode=process.argv[2];const workerId=process.argv[3];
if(!workerId||!['crash','crash-after-boundary','recover'].includes(mode??''))throw new Error('usage: crash-worker.ts <crash|crash-after-boundary|recover> <worker-id>');
const url=new URL(process.env.DATABASE_URL_WORKER??'');url.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;
const pool=new Pool({connectionString:url.toString(),max:1});
async function resultRef(claim:NonNullable<Awaited<ReturnType<typeof claimNextStep>>>):Promise<string>{
 const order=await withRunTenant(pool,claim.runId,async(client)=>{
  const result=await client.query<{step_order:number}>('SELECT step_order FROM runs.steps WHERE run_id=$1 AND step_id=$2',[claim.runId,claim.stepId]);
  return result.rows[0]?.step_order??0;
 });
 const refs=['golden://phase0/summary','golden://phase0/count'];const ref=refs[order-1];if(!ref)throw new Error(`No golden result for step order ${order}`);return ref;
}
const claim=await claimNextStep(pool,workerId,60_000);
if(!claim){await pool.end();process.exit(2);}
if(mode==='crash-after-boundary'){
 const completed=await completeStep(pool,claim,{resultRef:await resultRef(claim)});
 if(!completed){await pool.end();process.exit(3);}
 const next=await claimNextStep(pool,workerId,60_000);
 if(!next){await pool.end();process.exit(4);}
 process.stdout.write(`${JSON.stringify(next)}\n`);
 await new Promise<void>(()=>{});
}
process.stdout.write(`${JSON.stringify(claim)}\n`);
if(mode==='crash'){
 await new Promise<void>(()=>{});
}else{
 const completed=await completeStep(pool,claim,{resultRef:await resultRef(claim)});
 if(!completed){await pool.end();process.exit(3);}
 await pool.end();
}

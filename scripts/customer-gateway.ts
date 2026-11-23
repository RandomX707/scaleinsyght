import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createOutboundClient } from '@scaleinsyght/customer-gateway';
import { AnalyticPlanSchema } from '@scaleinsyght/contracts';

config({path:resolve(process.cwd(),'.env'),override:false});
const controlUrl=process.env.CONTROL_PLANE_URL;const credential=process.env.GATEWAY_CREDENTIAL;const sourceId=process.env.GATEWAY_SOURCE_ID;const databaseUrl=process.env.DATABASE_URL_SAMPLE_SOURCE;
if(!controlUrl||!credential||!sourceId||!databaseUrl)throw new Error('CONTROL_PLANE_URL, GATEWAY_CREDENTIAL, GATEWAY_SOURCE_ID, and DATABASE_URL_SAMPLE_SOURCE are required');
const source=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:10_000,options:'-c default_transaction_read_only=on'});
const role=await source.query<{rolsuper:boolean;rolcreatedb:boolean;rolcreaterole:boolean;transaction_read_only:string}>('SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,current_setting(\'transaction_read_only\') AS transaction_read_only FROM pg_roles r WHERE r.rolname=current_user');
if(!role.rows[0]||role.rows[0].rolsuper||role.rows[0].rolcreatedb||role.rows[0].rolcreaterole||role.rows[0].transaction_read_only!=='on')throw new Error('gateway_source_role_not_read_only');
const gateway=createOutboundClient({baseUrl:controlUrl,credential});let stopping=false;let delay=1000;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
while(!stopping){
  try{
    const result=await gateway.processNext(async(value)=>{
      const plan=AnalyticPlanSchema.parse(value);
      if(plan.scope.source_ids.length!==1||plan.scope.source_ids[0]!==sourceId||plan.steps.length!==1)throw new Error('gateway_source_plan_mismatch');
      const count=await source.query<{value:number}>("SELECT count(*)::int AS value FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type IN ('BASE TABLE','VIEW')");
      return [{metric:'accessible_table_count',value:count.rows[0]!.value}];
    });
    delay=1000;if(result.status==='empty')await sleep(2000);
  }catch(error){
    const message=error instanceof Error?error.message:'';const safe=['gateway_credential_invalid','gateway_poll_failed','gateway_plan_rejected','gateway_source_plan_mismatch','gateway_result_invalid','gateway_result_submission_failed','gateway_source_role_not_read_only'].includes(message)?message:'gateway_processing_failed';
    process.stderr.write(`Customer gateway retry: ${safe}\n`);await sleep(delay);delay=Math.min(delay*2,30_000);
  }
}
await source.end();

if(process.argv[1]&&resolve(process.argv[1])!==fileURLToPath(import.meta.url))throw new Error('unexpected_gateway_entrypoint');

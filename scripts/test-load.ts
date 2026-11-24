import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

config({path:resolve(process.cwd(),'.env')});
function dbUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE') {const value=process.env[key];if(!value)throw new Error(`${key} is required for the load check`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
function percentile(values:number[],p:number){return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;}

export async function runLoadCheck(count=100):Promise<{runs:number;p50Ms:number;p95Ms:number;maxMs:number}>{
  const tenantId=`phase6-load-${randomUUID()}`;const email=`${tenantId}@synthetic.invalid`;const appPool=new Pool({connectionString:dbUrl('DATABASE_URL')});const migratePool=new Pool({connectionString:dbUrl('DATABASE_URL_MIGRATE')});
  let server:Awaited<ReturnType<typeof buildServer>>|undefined;
  try{
    await withTenant(migratePool,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,email,hashPassword('synthetic-load-password')]);});
    const principal=await withTenant(migratePool,tenantId,db=>db.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]));const principalId=principal.rows[0]!.user_id;
    await withTenant(migratePool,tenantId,db=>db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)",[tenantId]));
    const source=await activateConnection(appPool,{tenantId,principalId,connectorType:'postgres'});
    await withTenant(migratePool,tenantId,db=>db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id,allowed) VALUES($1,$2,'analytic.read',$3,true)",[tenantId,principalId,source.connectionId]));
    server=await buildServer({pool:appPool,sessionSecret:'phase6-load-synthetic-session-secret-0123456789',testAccounts:[{tenantId,email}],testAnalyticPlanner:async()=>null});
    const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email,password:'synthetic-load-password'}});if(login.statusCode!==200)throw new Error('load_login_failed');const cookie=String(login.headers['set-cookie']).split(';')[0]!;
    const elapsed:number[]=[];
    for(let index=0;index<count;index++){
      const start=performance.now();const created=await server.inject({method:'POST',url:'/api/runs',headers:{cookie},payload:{question:`Count synthetic sample ${index}`,sourceIds:[source.connectionId]}});
      if(created.statusCode!==201){const error=created.json<{error?:string}>().error??'unexpected';throw new Error(`load_run_create_failed_${created.statusCode}_${error}`);}const runId=created.json<{runId:string}>().runId;
      const events=await server.inject({method:'GET',url:`/api/runs/${runId}/events`,headers:{cookie}});if(events.statusCode!==200||events.json<{events:unknown[]}>().events.length===0)throw new Error('load_first_progress_event_missing');elapsed.push(performance.now()-start);
    }
    const result={runs:elapsed.length,p50Ms:percentile(elapsed,.5),p95Ms:percentile(elapsed,.95),maxMs:Math.max(...elapsed)};
    if(result.runs!==count)throw new Error('load_run_count_mismatch');if(result.p95Ms>=3000)throw new Error('first_progress_p95_target_missed');
    await withTenant(migratePool,tenantId,async(db)=>{await db.query("UPDATE runs.steps SET state='CANCELLED' WHERE tenant_id=$1",[tenantId]);await db.query("UPDATE runs.runs SET state='CANCELLED',state_version=state_version+1 WHERE tenant_id=$1 AND state NOT IN ('COMPLETED','CANCELLED','FAILED')",[tenantId]);});
    return result;
  }finally{await server?.close();await appPool.end();await migratePool.end();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runLoadCheck().then((result)=>process.stdout.write(`Synthetic load passed: runs=${result.runs}, first event p50=${result.p50Ms.toFixed(1)}ms, p95=${result.p95Ms.toFixed(1)}ms, max=${result.maxMs.toFixed(1)}ms\n`)).catch((error:unknown)=>{process.stderr.write(`Synthetic load failed: ${error instanceof Error?error.message:'load_check_failed'}\n`);process.exitCode=1;});

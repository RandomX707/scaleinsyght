import { afterAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { queryLineage } from '@scaleinsyght/graph';

config({ path: '.env' });
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'):string{
  const value=process.env[key];if(!value)throw new Error(`${key} is required; graph benchmarks require real PostgreSQL`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const app=new Pool({connectionString:testUrl('DATABASE_URL'),max:2,options:'-c statement_timeout=10000 -c application_name=phase3-graph-benchmark'});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE'),max:2});
const monitor=new Pool({connectionString:testUrl('DATABASE_URL'),max:2,options:'-c statement_timeout=10000 -c application_name=phase3-graph-benchmark-monitor'});

async function sampleActivity(tenantId:string):Promise<Array<{pid:number;state:string|null;wait_event_type:string|null;wait_event:string|null;query:string}>>{
  return withTenant(monitor,tenantId,async(client)=>{
    const result=await client.query<{pid:number;state:string|null;wait_event_type:string|null;wait_event:string|null;query:string}>(
      `SELECT pid,state,wait_event_type,wait_event,left(query,500) AS query
       FROM pg_stat_activity
       WHERE application_name='phase3-graph-benchmark' AND usename=current_user
         AND pid<>pg_backend_pid() AND state='active'`);
    return result.rows;
  });
}

describe('phase 3 graph traversal benchmark',()=>{
  afterAll(async()=>{await app.end();await migrate.end();await monitor.end();});
  it('c6_postgres_depth_four_traversal_on_100k_assets_meets_one_second_p95_regression_guard',async()=>{
    const tenantId=`graph-bench-${crypto.randomUUID()}`;
    const userId=await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      const result=await client.query<{user_id:string}>("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",[tenantId,`${tenantId}@synthetic.example`]);
      return result.rows[0]!.user_id;
    });
    const connection=await activateConnection(app,{tenantId,principalId:userId,connectorType:'postgres'});
    await withTenant(migrate,tenantId,async(client)=>{
      await client.query(`INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint)
        SELECT $1,$2,'dataset','bench.'||n,decode(md5($1||'.'||n),'hex') FROM generate_series(1,100000) AS n`,[tenantId,connection.connectionId]);
      await client.query(`WITH nodes AS (SELECT split_part(qualified_name,'.',2)::int AS n,asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name LIKE 'bench.%')
        INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
        SELECT $1,'data_flow','DERIVES_FROM',parent.asset_id,child.asset_id,'dataset' FROM nodes child JOIN nodes parent ON parent.n=CASE
          WHEN child.n BETWEEN 2 AND 50 THEN 1
          WHEN child.n BETWEEN 51 AND 2451 THEN 2+((child.n-51)/49)
          WHEN child.n BETWEEN 2452 AND 7253 THEN 51+((child.n-2452)/2)
          WHEN child.n>7253 THEN 2452+((child.n-7254)%4802)
        END WHERE child.n>1`,[tenantId]);
      await client.query(`WITH nodes AS (SELECT split_part(qualified_name,'.',2)::int AS n,asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name LIKE 'bench.%'),
        shortcuts AS (SELECT i,2452+(i%4802) AS child_n,51+(((i%4802)/2)+1+(i/4802))%2401 AS parent_n FROM generate_series(0,4999) AS i)
        INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
        SELECT $1,'data_flow','MAPS_TO',parent.asset_id,child.asset_id,'dataset' FROM shortcuts s
        JOIN nodes child ON child.n=s.child_n JOIN nodes parent ON parent.n=s.parent_n`,[tenantId]);
      const evidence=await client.query<{evidence_id:string}>(
        "INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'manifest','{\"fixture\":\"synthetic_graph_benchmark\"}') RETURNING evidence_id",[tenantId]);
      await client.query(`INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,collector_version)
        SELECT $1,relationship_id,'declared',ARRAY[$2::uuid],0.950,'phase3-benchmark-v1'
        FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow'`,[tenantId,evidence.rows[0]!.evidence_id]);
    });
    await migrate.query('ANALYZE graph.assets');
    await migrate.query('ANALYZE graph.relationships');
    await migrate.query('ANALYZE graph.assertions');
    await migrate.query('ANALYZE graph.evidence');
    await migrate.query('ANALYZE graph.gaps');
    const degree=await withTenant(migrate,tenantId,async(client)=>client.query<{average_degree:number;maximum_degree:number;hub_count:number}>(
      `WITH degrees AS (
         SELECT asset_id,count(*)::int AS degree FROM (
           SELECT from_asset_id AS asset_id FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow'
           UNION ALL SELECT to_asset_id FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow'
         ) edges GROUP BY asset_id
       ) SELECT avg(coalesce(degree,0))::float AS average_degree,max(coalesce(degree,0))::int AS maximum_degree,
         count(*) FILTER(WHERE coalesce(degree,0)>10)::int AS hub_count
       FROM graph.assets a LEFT JOIN degrees d USING(asset_id) WHERE a.tenant_id=$1`,[tenantId]));
    console.info(`Fan-out (incident edges): average ${degree.rows[0]!.average_degree.toFixed(3)}, maximum ${degree.rows[0]!.maximum_degree}, hubs over 10 edges ${degree.rows[0]!.hub_count}`);
    expect(degree.rows[0]!.average_degree).toBeGreaterThanOrEqual(2);
    expect(degree.rows[0]!.average_degree).toBeLessThanOrEqual(5);
    expect(degree.rows[0]!.maximum_degree).toBeLessThanOrEqual(50);
    const starts=await withTenant(migrate,tenantId,async(client)=>client.query<{asset_id:string}>(
      "SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name LIKE 'bench.%' ORDER BY md5(asset_id::text) LIMIT 50",[tenantId]));
    const rls=await withTenant(app,tenantId,async(client)=>client.query<{role:string;tenant:string}>(
      "SELECT current_user AS role,current_setting('app.tenant_id') AS tenant"));
    expect(rls.rows[0]).toEqual({role:'si_app',tenant:tenantId});
    const explain=await withTenant(app,tenantId,async(client)=>client.query<{ 'QUERY PLAN':string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
       SELECT r.from_asset_id,r.to_asset_id,r.relationship_id,r.granularity FROM graph.relationships r
       WHERE $3 IN ('downstream','both') AND r.tenant_id=$1 AND r.family='data_flow' AND r.from_asset_id=ANY($2::uuid[])
         AND EXISTS(SELECT 1 FROM graph.assertions a WHERE a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
           AND ($4::timestamptz IS NULL OR (a.captured_at<=$4 AND (a.valid_from IS NULL OR a.valid_from<=$4) AND (a.valid_to IS NULL OR a.valid_to>=$4)))
           AND ($5::text[] IS NULL OR a.evidence_method=ANY($5::text[])))
       UNION
       SELECT r.from_asset_id,r.to_asset_id,r.relationship_id,r.granularity FROM graph.relationships r
       WHERE $3 IN ('upstream','both') AND r.tenant_id=$1 AND r.family='data_flow' AND r.to_asset_id=ANY($2::uuid[])
         AND EXISTS(SELECT 1 FROM graph.assertions a WHERE a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
           AND ($4::timestamptz IS NULL OR (a.captured_at<=$4 AND (a.valid_from IS NULL OR a.valid_from<=$4) AND (a.valid_to IS NULL OR a.valid_to>=$4)))
           AND ($5::text[] IS NULL OR a.evidence_method=ANY($5::text[])))`,[tenantId,[starts.rows[0]!.asset_id],'both',null,null]));
    console.info(`EXPLAIN ANALYZE on si_app with RLS enabled:\n${explain.rows.map(row=>row['QUERY PLAN']).join('\n')}`);
    const samples:number[]=[];
    const activeSamples:Array<{wait_event_type:string|null;wait_event:string|null;query:string}> = [];
    for(const start of starts.rows){
      const started=performance.now();
      let monitoring=true;
      const monitorTask=(async()=>{while(monitoring){
        activeSamples.push(...(await sampleActivity(tenantId)));
        await new Promise(resolve=>setTimeout(resolve,100));
      }})();
      try{
        const result=await queryLineage(app,{tenantId,assetId:start.asset_id,direction:'both',maxDepth:4});
        expect(result.asset_ids).toContain(start.asset_id);
        expect(result.edges.length).toBeGreaterThan(0);
      }finally{
        monitoring=false;
        await monitorTask;
      }
      samples.push(performance.now()-started);
    }
    samples.sort((a,b)=>a-b);
    const p50=samples[Math.ceil(samples.length*0.5)-1]!;
    const p95=samples[Math.ceil(samples.length*0.95)-1]!;
    const maximum=samples.at(-1)!;
    console.info(`50 random depth-four traversals: p50=${p50.toFixed(1)} ms, p95=${p95.toFixed(1)} ms, max=${maximum.toFixed(1)} ms`);
    console.info(`pg_stat_activity samples: ${activeSamples.length}; lock waits=${activeSamples.filter(row=>row.wait_event_type==='Lock').length}`);
    if(activeSamples.some(row=>row.wait_event_type==='Lock'))console.info(`Lock-wait sample: ${JSON.stringify(activeSamples.find(row=>row.wait_event_type==='Lock'))}`);
    expect(p95).toBeLessThan(1000);
  },300_000);
});

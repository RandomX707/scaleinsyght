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
const app=new Pool({connectionString:testUrl('DATABASE_URL'),max:2});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE'),max:2});

describe('phase 3 graph traversal benchmark',()=>{
  afterAll(async()=>{await app.end();await migrate.end();});
  it('c6_postgres_depth_four_traversal_on_100k_assets_meets_five_second_p95',async()=>{
    const tenantId=`graph-bench-${crypto.randomUUID()}`;
    const userId=await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      const result=await client.query<{user_id:string}>("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",[tenantId,`${tenantId}@synthetic.example`]);
      return result.rows[0]!.user_id;
    });
    console.info('benchmark: tenant created');
    const connection=await activateConnection(app,{tenantId,principalId:userId,connectorType:'postgres'});
    console.info('benchmark: connection activated');
    const rootId=await withTenant(migrate,tenantId,async(client)=>{
      await client.query(`INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint)
        SELECT $1,$2,'dataset','bench.'||n,decode(md5($1||'.'||n),'hex') FROM generate_series(1,100000) AS n`,[tenantId,connection.connectionId]);
      console.info('benchmark: assets inserted');
      await client.query(`WITH nodes AS (SELECT split_part(qualified_name,'.',2)::int AS n,asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name LIKE 'bench.%')
        INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
        SELECT $1,'data_flow','DERIVES_FROM',parent.asset_id,child.asset_id,'dataset' FROM nodes child JOIN nodes parent ON parent.n=CASE
          WHEN child.n BETWEEN 2 AND 11 THEN 1
          WHEN child.n BETWEEN 12 AND 111 THEN 2+((child.n-12)/10)
          WHEN child.n BETWEEN 112 AND 10111 THEN 12+((child.n-112)/100)
          WHEN child.n>10111 THEN 112+((child.n-10112)/10)
        END WHERE child.n>1`,[tenantId]);
      console.info('benchmark: edges inserted');
      return (await client.query<{asset_id:string}>("SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name='bench.1'",[tenantId])).rows[0]!.asset_id;
    });
    console.info('benchmark: seed committed');
    const samples:number[]=[];
    for(let index=0;index<5;index++){
      const started=performance.now();
      const result=await queryLineage(app,{tenantId,assetId:rootId,direction:'downstream'});
      console.info(`benchmark: traversal ${index+1} completed in ${(performance.now()-started).toFixed(1)} ms`);
      samples.push(performance.now()-started);
      expect(result.asset_ids).toHaveLength(100000);
      expect(result.edges).toHaveLength(99999);
    }
    samples.sort((a,b)=>a-b);
    const p95=samples[Math.ceil(samples.length*0.95)-1]!;
    console.info(`Phase 3 depth-four traversal p95: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(5000);
  },300_000);
});

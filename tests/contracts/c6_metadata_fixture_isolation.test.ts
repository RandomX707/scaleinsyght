import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { importGoldenMetadata } from '../support/golden-graph.js';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'):string{
  const value=process.env[key];if(!value)throw new Error(`${key} is required; metadata contract tests require real PostgreSQL`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const app=new Pool({connectionString:testUrl('DATABASE_URL')});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});

describe('c6 metadata fixture isolation and idempotency',()=>{
  afterAll(async()=>{await app.end();await migrate.end();});

  it('c6_metadata_import_owns_only_named_fixture_assets_and_repeats_without_duplicate_facts',async()=>{
    const tenantId=`phase3-fixtures-${crypto.randomUUID()}`;
    const principalId=await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      return (await client.query<{user_id:string}>("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",[tenantId,`${tenantId}@synthetic.example`])).rows[0]!.user_id;
    });
    const connections=await Promise.all([
      activateConnection(app,{tenantId,principalId,connectorType:'dbt',sourceRef:'golden-dbt'}),
      activateConnection(app,{tenantId,principalId,connectorType:'tableau',sourceRef:'golden-tableau'}),
      activateConnection(app,{tenantId,principalId,connectorType:'power_bi',sourceRef:'golden-powerbi'}),
    ]);
    const inputs=[
      {connectionId:connections[0]!.connectionId,fixtureKey:'dbt-manifest'},
      {connectionId:connections[1]!.connectionId,fixtureKey:'tableau-reports'},
      {connectionId:connections[2]!.connectionId,fixtureKey:'power-bi-reports'},
    ];
    for(const input of inputs)await importGoldenMetadata(app,{tenantId,principalId,...input});
    for(const input of inputs)await importGoldenMetadata(app,{tenantId,principalId,...input});
    const ownership=await withTenant(migrate,tenantId,async(client)=>client.query<{name:string;source_ref:string}>(
      `SELECT a.qualified_name AS name,c.source_ref FROM graph.assets a
       JOIN registry.connections c ON c.tenant_id=a.tenant_id AND c.connection_id=a.source_id
       WHERE a.tenant_id=$1 ORDER BY a.qualified_name`,[tenantId]));
    expect(ownership.rows).toEqual(expect.arrayContaining([
      {name:'dbt.customer_mart',source_ref:'golden-dbt'},
      {name:'dbt.customer_mart.customer_key',source_ref:'golden-dbt'},
      {name:'Tableau.Customer Summary',source_ref:'golden-tableau'},
      {name:'Power BI.Customer Health',source_ref:'golden-powerbi'},
      {name:'Power BI.Customer Health.Active Customers',source_ref:'golden-powerbi'},
    ]));
    expect(ownership.rows).toHaveLength(5);
    const before=await withTenant(migrate,tenantId,async(client)=>client.query<{assets:number;flows:number;assertions:number;evidence:number;gaps:number;id_fields:number;id_path_steps:number;report_events:number}>(
      `SELECT (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1) assets,
       (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow') flows,
       (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
       (SELECT count(*)::int FROM graph.evidence WHERE tenant_id=$1) evidence,
       (SELECT count(*)::int FROM graph.gaps WHERE tenant_id=$1) gaps,
       (SELECT count(*)::int FROM graph.id_fields WHERE tenant_id=$1) id_fields,
       (SELECT count(*)::int FROM graph.id_path_steps WHERE tenant_id=$1) id_path_steps,
       (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1 AND event_type='report_impacted') report_events`,[tenantId]));
    for(const input of inputs)await importGoldenMetadata(app,{tenantId,principalId,...input});
    const after=await withTenant(migrate,tenantId,async(client)=>client.query<{assets:number;flows:number;assertions:number;evidence:number;gaps:number;id_fields:number;id_path_steps:number;report_events:number}>(
      `SELECT (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1) assets,
       (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow') flows,
       (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
       (SELECT count(*)::int FROM graph.evidence WHERE tenant_id=$1) evidence,
       (SELECT count(*)::int FROM graph.gaps WHERE tenant_id=$1) gaps,
       (SELECT count(*)::int FROM graph.id_fields WHERE tenant_id=$1) id_fields,
       (SELECT count(*)::int FROM graph.id_path_steps WHERE tenant_id=$1) id_path_steps,
       (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1 AND event_type='report_impacted') report_events`,[tenantId]));
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

import { describe, expect, it } from 'vitest';
import { afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createCrmConnector, createLakeConnector } from '../support/test-generic-connectors.js';
import { buildTestServer as buildServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required; enterprise connector contract tests are never skipped`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const appPool=new Pool({connectionString:testUrl('DATABASE_URL')});const adminPool=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});
const tenantId=`enterprise-read-${randomUUID()}`;const email=`admin@${tenantId}.synthetic.invalid`;
let server:Awaited<ReturnType<typeof buildServer>>;let cookie='';

describe('contract 2 generic enterprise read connectors', () => {
  beforeAll(async()=>{
    await withTenant(adminPool,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,email,hashPassword('synthetic-enterprise-password')]);});
    server=await buildServer({pool:appPool,sessionSecret:'phase6-enterprise-connector-session-secret-0123456789',testAccounts:[{tenantId,email}]});
    const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email,password:'synthetic-enterprise-password'}});cookie=String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async()=>{await server?.close();await appPool.end();await adminPool.end();});
  it('c2_lake_and_crm_read_connectors_obey_shared_read_only_contract', async () => {
    for (const connector of [createLakeConnector(), createCrmConnector()]) {
      await expect(connector.test()).resolves.toEqual({ ok: true, capabilities: ['discover', 'profile'], readOnly: true });
      const first = await connector.discover({ mode: 'profile' });
      const second = await connector.discover({ mode: 'profile' });
      expect(first.objects.length).toBeGreaterThan(0);
      expect(first.objects.map((asset) => asset.assetKey)).toEqual(second.objects.map((asset) => asset.assetKey));
      const profile = await connector.profile(first.objects[0]!.assetKey);
      expect(profile.qualifiedName).toBe(first.objects[0]!.qualifiedName);
      expect(await connector.queryAggregate?.(first.objects[0]!.assetKey, 'count')).toMatchObject({ metric: 'count', value: expect.any(Number) });
      expect(connector).not.toHaveProperty('insert');
      expect(connector).not.toHaveProperty('update');
      expect(connector).not.toHaveProperty('delete');
      expect(connector).not.toHaveProperty('execute');
    }
  });

  it('c2_runtime_rejects_fixture_source_ids_instead_of_activating_test_connectors',async()=>{
    for(const sourceId of ['synthetic-lake','synthetic-crm']){
      const rejected=await server.inject({method:'POST',url:'/api/connections',headers:{cookie},payload:{sourceId}});expect(rejected.statusCode).toBe(400);expect(rejected.json()).toMatchObject({error:'connector_type_unsupported'});
    }
  });
});

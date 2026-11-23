import { expect,test,type Page } from '@playwright/test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { getGoldenHubFixtures } from '@scaleinsyght/hub-adapters';
import { withTenant } from '@scaleinsyght/db';
import phase4E2e from '../golden/phase4-e2e.json' with { type:'json' };

config({path:'.env'});
const fixture=getGoldenHubFixtures();
function testConnection(){const source=process.env.DATABASE_URL_MIGRATE;if(!source)throw new Error('DATABASE_URL_MIGRATE is required for Phase 4 E2E tenant setup');const url=new URL(source);url.pathname='/si_test';return url.toString();}
const setupPool=new Pool({connectionString:testConnection()});
test.afterAll(async()=>setupPool.end());
async function createTenant(connected:boolean){
 const tenantId=connected?'phase4-e2e-journey':'phase4-e2e-disconnected';const members=phase4E2e.users.filter(user=>user.tenantId===tenantId);const accounts={owner:members.find(user=>user.email.startsWith('owner@'))!.email,reviewer:members.find(user=>user.email.startsWith('reviewer@'))!.email};
 await withTenant(setupPool,tenantId,async(db)=>{
  const tenant=phase4E2e.tenants.find(item=>item.id===tenantId)!;await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET name=EXCLUDED.name',[tenantId,tenant.name]);
  for(const user of members)await db.query('INSERT INTO core.users(tenant_id,user_id,email,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,email) DO UPDATE SET password_hash=EXCLUDED.password_hash',[tenantId,user.id,user.email,hashPassword('golden-local-only',user.id)]);
  if(connected){
   const owner=members.find(user=>user.email===accounts.owner)!;const ownerRow=await db.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND email=$2',[tenantId,owner.email]);await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'semantics.metric.read',1,'READ','not_applicable',true) ON CONFLICT(tenant_id,capability_id) DO UPDATE SET enabled=true",[tenantId]);await db.query("INSERT INTO registry.capability_versions(tenant_id,capability_id,version,input_schema,output_schema) VALUES($1,'semantics.metric.read',1,'{}','{}') ON CONFLICT DO NOTHING",[tenantId]);await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) SELECT $1,$2,'semantics.metric.read','active_customers' WHERE NOT EXISTS(SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='semantics.metric.read' AND resource_id='active_customers')",[tenantId,ownerRow.rows[0]!.user_id]);
   for(const adapter of fixture.adapters){await db.query('INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,product) DO UPDATE SET connected=EXCLUDED.connected,current_version=EXCLUDED.current_version',[tenantId,adapter.product,adapter.connected,adapter.version]);await db.query('INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,product,version) DO NOTHING',[tenantId,adapter.product,adapter.version,adapter.fixtureKey,JSON.stringify(adapter.capabilities)]);}
   const metric=fixture.metrics[0]!;const semantics=fixture.adapters.find(item=>item.product==='semantics')!;
   await db.query(`INSERT INTO hub.certified_metrics(tenant_id,metric_id,adapter_version,name,description,dimensions,unit,certified,fixture_key,source_asset) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) ON CONFLICT(tenant_id,metric_id) DO NOTHING`,[tenantId,metric.id,semantics.version,metric.name,metric.description,JSON.stringify(metric.dimensions),metric.unit,metric.certified,metric.fixtureKey,metric.sourceAsset]);
  }
 });
 return {tenantId,accounts};
}
async function signIn(page:Page,email:string){await page.goto('/login');await page.getByLabel('Email').fill(email);await page.getByLabel('Password').fill('golden-local-only');const login=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login');await page.getByRole('button',{name:'Sign in'}).click();expect((await login).status()).toBe(200);await page.waitForURL(url=>url.pathname==='/');}
async function signOut(page:Page){await page.getByRole('button',{name:'Workspace profile'}).click();await page.getByRole('menuitem',{name:'Sign out'}).click();}

test('c4_hub_empty_state_is_scoped_to_a_new_tenant_without_connected_adapters',async({page})=>{
 const {accounts}=await createTenant(true);await signIn(page,accounts.owner);await page.getByRole('link',{name:'Hub integrations'}).click();await expect(page.getByRole('heading',{name:'Hub integrations'})).toBeVisible();await page.getByRole('button',{name:'Disconnect semantics'}).click();await expect(page.getByText('No certified metrics are available while Semantics is disconnected.')).toBeVisible();await page.getByRole('button',{name:'Disconnect data studio'}).click();await expect(page.getByText('data studio · Disconnected · version 1')).toBeVisible();const lineage=await page.evaluate(async()=>fetch('/api/lineage/assets').then(response=>response.status));expect(lineage).toBe(200);
});

test('c4_and_c8_certified_metric_and_two_member_flowspec_handoff',async({page})=>{
 const {accounts}=await createTenant(true);await signIn(page,accounts.owner);await page.getByRole('link',{name:'Hub integrations'}).click();
 const metricResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/semantics/metrics/active_customers/query');await page.getByRole('button',{name:'Query Active customers'}).click();expect((await metricResponse).status()).toBe(201);await expect(page.getByText('active_customers: 1284')).toBeVisible();await expect(page.getByText('hub://semantics/metrics/active_customers')).toBeVisible();
 await page.getByRole('button',{name:'Create synthetic FlowSpec'}).click();await expect(page.getByRole('heading',{name:'FlowSpec approval'})).toBeVisible();await expect(page.getByText('Awaiting approval')).toBeVisible();const flowUrl=page.url();
 await signOut(page);await signIn(page,accounts.reviewer);const flowResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api${new URL(flowUrl).pathname}`);await page.goto(flowUrl);expect((await flowResponse).status()).toBe(200);await expect(page.getByRole('button',{name:'Approve version 1'})).toBeVisible();await page.getByRole('button',{name:'Approve version 1'}).click();await expect(page.getByRole('status')).toContainText('Version 1 approved.');await expect(page.getByRole('button',{name:'Send version 1 to Data Studio'})).toBeVisible();
 await signOut(page);await signIn(page,accounts.owner);await page.goto(flowUrl);await page.getByRole('button',{name:'Create changed version'}).click();await expect(page.getByRole('heading',{name:/revised · version 2/})).toBeVisible();await expect(page.getByText('Awaiting approval').last()).toBeVisible();
 await signOut(page);await signIn(page,accounts.reviewer);await page.goto(flowUrl);await expect(page.getByRole('button',{name:'Approve version 2'})).toBeVisible();await page.getByRole('button',{name:'Approve version 2'}).click();await expect(page.getByRole('status')).toContainText('Version 2 approved.');
 await signOut(page);await signIn(page,accounts.owner);await page.goto(flowUrl);await page.getByRole('button',{name:'Send version 2 to Data Studio'}).click();await expect(page.getByRole('status')).toContainText('Receiver confirmed version 2.');
});

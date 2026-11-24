import { expect,test,type Page } from '@playwright/test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required for Phase 5 E2E tenant setup`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const setup=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});
const app=new Pool({connectionString:testUrl('DATABASE_URL')});
test.afterAll(async()=>{await setup.end();await app.end();});

async function createTenant(tenantId:string,withReviewer=false,withSource=true){
 const ownerId=crypto.randomUUID();const reviewerId=withReviewer?crypto.randomUUID():null;const ownerEmail=`owner@${tenantId}.synthetic.example`;const reviewerEmail=reviewerId?`reviewer@${tenantId}.synthetic.example`:null;
 await withTenant(setup,tenantId,async(db)=>{
  await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
  await db.query('INSERT INTO core.users(tenant_id,user_id,email,password_hash) VALUES($1,$2,$3,$4)',[tenantId,ownerId,ownerEmail,hashPassword('golden-local-only',ownerId)]);
  if(reviewerId&&reviewerEmail)await db.query('INSERT INTO core.users(tenant_id,user_id,email,password_hash) VALUES($1,$2,$3,$4)',[tenantId,reviewerId,reviewerEmail,hashPassword('golden-local-only',reviewerId)]);
  await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)",[tenantId]);
 });
 let sourceId:string|null=null;
 if(withSource){const source=await (await import('@scaleinsyght/registry')).activateConnection(app,{tenantId,principalId:ownerId,connectorType:'postgres'});sourceId=source.connectionId;await withTenant(setup,tenantId,async(db)=>db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)",[tenantId,ownerId,source.connectionId]));}
 return{tenantId,ownerEmail,reviewerEmail,sourceId};
}
async function signIn(page:Page,email:string){await signInToTestWorkspace(page,email);}
async function signOut(page:Page){await page.getByRole('button',{name:'Account'}).click();await page.getByRole('menuitem',{name:'Sign out'}).click();await page.waitForURL(url=>url.pathname==='/login');}
async function openWorkspace(page:Page){const toggle=page.getByRole('button',{name:/Workspace/});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();}

test('empty_new_tenant_has_no_canned_answer_or_saved_questions',async({page})=>{
 const tenant=await createTenant('phase5-e2e-empty-tenant',false,false);await signIn(page,tenant.ownerEmail);
 await expect(page.getByRole('heading',{name:'Connect a source to get started'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send question'})).toBeDisabled();
 await page.getByRole('link',{name:/Agents/}).click();await expect(page.getByRole('heading',{name:'Saved questions'})).toBeVisible();
 await expect(page.getByText('No saved questions yet.')).toBeVisible();
});

test('c5_governed_report_exports_evidence_and_has_an_owner_scoped_daily_schedule',async({page})=>{
 const tenant=await createTenant('phase5-e2e-reports',true);await signIn(page,tenant.ownerEmail);
 await page.getByRole('link',{name:/Agents/}).click();await page.getByLabel('Name').fill('Daily catalog summary');await page.getByLabel('Question').fill('How many catalog objects are listed?');await page.getByRole('button',{name:'Save draft version'}).click();await expect(page.getByRole('status')).toContainText('Draft version 1 saved');
 await signOut(page);await signIn(page,tenant.reviewerEmail!);await page.getByRole('link',{name:/Approval matrix/}).click();await expect(page.getByText('Daily catalog summary · version 1 · Awaiting approval')).toBeVisible();await page.getByRole('button',{name:'Approve version 1'}).click();await expect(page.getByRole('status')).toContainText('Version 1 approved');
 await signOut(page);await signIn(page,tenant.ownerEmail);await openWorkspace(page);await page.getByRole('button',{name:'Account'}).click();await page.getByRole('menuitem',{name:'Reports',exact:true}).click();await page.getByLabel('Report name').fill('Daily catalog report');await page.getByLabel('Approved definition').selectOption({label:'Daily catalog summary · version 1'});await page.getByRole('button',{name:'Save report'}).click();await expect(page.getByRole('status')).toContainText('Governed report saved');
 await page.getByRole('button',{name:'Run report'}).click();await expect(page.getByRole('status')).toContainText('Report run');
 await expect.poll(async()=>page.evaluate(async()=>{const r=await fetch('/api/me/reports');const d=await r.json() as {reports:Array<{latestSnapshotId:string|null}>};return d.reports[0]?.latestSnapshotId??null;}),{timeout:15000}).not.toBeNull();
 await page.reload();const pdfDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF'}).click();expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/);
 await page.getByLabel('Daily schedule for Daily catalog report').fill('23:59');await page.getByRole('button',{name:'Schedule daily'}).click();await expect(page.getByRole('status')).toContainText('Daily schedule saved');await page.getByRole('button',{name:'Disable schedule'}).click();await expect(page.getByRole('status')).toContainText('Schedule disabled');
});

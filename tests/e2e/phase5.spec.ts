import { expect,test,type Page } from '@playwright/test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required for Phase 5 E2E tenant setup`);const url=new URL(value);url.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;return url.toString();}
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
 // Saved questions live on My agent, as in the prototype.
 await page.goto('/my-agent');await expect(page.getByRole('heading',{name:'Saved questions',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'No saved questions yet',exact:true})).toBeVisible();
});

test('c5_governed_report_exports_evidence_and_has_an_owner_scoped_daily_schedule',async({page})=>{
 const tenant=await createTenant('phase5-e2e-reports',true);await signIn(page,tenant.ownerEmail);
 await page.getByRole('link',{name:/Agents/}).click();await page.getByText('New governed agent',{exact:true}).click();await page.getByLabel('Name').fill('Daily catalog summary');await page.getByLabel('Question').fill('How many catalog objects are listed?');await page.getByRole('button',{name:'Save draft version'}).click();await expect(page.getByRole('status')).toContainText('Draft version 1 saved');
 await signOut(page);await signIn(page,tenant.reviewerEmail!);await page.getByRole('link',{name:/Approval matrix/}).click();await expect(page.getByText('Daily catalog summary · version 1 · Awaiting approval')).toBeVisible();await page.getByRole('button',{name:'Approve version 1'}).click();await expect(page.getByRole('status')).toContainText('Version 1 approved');
 await signOut(page);await signIn(page,tenant.ownerEmail);await openWorkspace(page);await page.getByRole('button',{name:'Account'}).click();await page.getByRole('menuitem',{name:'Reports',exact:true}).click();await page.getByLabel('Report name').fill('Daily catalog report');await page.getByLabel('Approved definition').selectOption({label:'Daily catalog summary · version 1'});await page.getByRole('button',{name:'Save report'}).click();await expect(page.getByRole('status')).toContainText('Governed report saved');
 await page.getByRole('button',{name:'Run report'}).click();await expect(page.getByRole('status')).toContainText('Report run');
 await expect.poll(async()=>page.evaluate(async()=>{const r=await fetch('/api/me/reports');const d=await r.json() as {reports:Array<{latestSnapshotId:string|null}>};return d.reports[0]?.latestSnapshotId??null;}),{timeout:15000}).not.toBeNull();
 await page.reload();const pdfDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF'}).click();expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/);
 await page.getByLabel('Daily schedule for Daily catalog report').fill('23:59');await page.getByRole('button',{name:'Schedule daily'}).click();await expect(page.getByRole('status')).toContainText('Daily schedule saved');await page.getByRole('button',{name:'Disable schedule'}).click();await expect(page.getByRole('status')).toContainText('Schedule disabled');
});

test('my_agent_matches_the_prototype_and_everything_it_remembers_can_be_deleted',async({page,browser})=>{
 // CLAUDE.md 10.2 and rule 12: answer style, default sources, your words, corrections and saved questions; remembers, never trains.
 const tenant=await createTenant(`phase5-e2e-my-agent-${crypto.randomUUID().slice(0,8)}`);await signIn(page,tenant.ownerEmail);
 await withTenant(setup,tenant.tenantId,db=>db.query("UPDATE registry.connections SET display_name='Orders warehouse' WHERE tenant_id=$1 AND connection_id=$2",[tenant.tenantId,tenant.sourceId]));
 // A correction as a thumbs down saves it (the feedback route writes the same memory).
 const seeded=await page.request.put('/api/me/agent',{data:{vocabulary:{},defaultSources:[],answerStyle:'concise',corrections:[{term:'active patient',meaning:'seen in the last 12 months'}]}});expect(seeded.ok()).toBe(true);
 await page.goto('/my-agent');
 await expect(page.getByText('Nothing is used to train a model, and you can edit or delete anything it holds.')).toBeVisible();
 for(const heading of ['How you like answers','Your default sources','Your words','Corrections','Saved questions'])await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
 await expect(page.getByText('It changes how answers are shaped, never what can be accessed.')).toBeVisible();
 // Your words: add one, see it, delete it.
 await page.getByLabel('Term').fill('census');await page.getByLabel('Meaning').fill('patients in a bed at midnight');await page.getByRole('button',{name:'Add word'}).click();
 await expect(page.locator('.memory-list').filter({hasText:'census'})).toContainText('means patients in a bed at midnight');
 // Default sources: add the tenant's source by name.
 await page.getByLabel('Add a default source').selectOption({label:'Orders warehouse'});await page.getByRole('button',{name:'Add default source'}).click();
 await expect(page.locator('.memory-list').filter({hasText:'Orders warehouse'})).toBeVisible();
 await expect(page.getByText('should be seen in the last 12 months')).toBeVisible();
 await page.reload();
 await expect(page.locator('.memory-list').filter({hasText:'census'})).toBeVisible(); // stored, not just shown
 // The UI report pair: the app's My agent beside the prototype's, at 1440x900.
 const {mkdirSync}=await import('node:fs');const {resolve}=await import('node:path');const {pathToFileURL}=await import('node:url');
 mkdirSync('docs/acceptance/phase5/prototype',{recursive:true});await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'docs/acceptance/phase5/my-agent.png'});
 const prototype=await browser.newPage({viewport:{width:1440,height:900}});
 try{await prototype.goto(pathToFileURL(resolve('docs/prototype/index.html')).href);await prototype.getByRole('button',{name:'Sign in',exact:true}).click();await prototype.evaluate('go("my-agent")');await expect(prototype.getByRole('heading',{name:'My agent'})).toBeVisible();await prototype.screenshot({path:'docs/acceptance/phase5/prototype/my-agent.png'});}
 finally{await prototype.close();}
 // Everything can be deleted.
 await page.getByRole('button',{name:'Delete census'}).click();await page.getByRole('button',{name:'Delete Orders warehouse'}).click();await page.getByRole('button',{name:'Delete active patient'}).click();
 await expect(page.getByText('No words yet.')).toBeVisible();await expect(page.getByText('No corrections yet.')).toBeVisible();
 await page.reload();
 await expect(page.getByText('No words yet.')).toBeVisible();await expect(page.getByText('No corrections yet.')).toBeVisible();await expect(page.getByText('None yet. Questions use the sources you pick each time.')).toBeVisible();
});

test('usage_shows_users_and_connectors_against_the_plan_allowance',async({page,browser})=>{
 // CLAUDE.md 10.2 and decision 71: active users and connectors by type, against the plan's allowance.
 const tenant=await createTenant(`phase5-e2e-usage-${crypto.randomUUID().slice(0,8)}`);
 await withTenant(setup,tenant.tenantId,db=>db.query('UPDATE core.tenants SET user_allowance=20 WHERE tenant_id=$1',[tenant.tenantId]));
 await signIn(page,tenant.ownerEmail);await page.goto('/usage');
 const users=page.locator('.usage-summary article').filter({hasText:'Active users'});
 await expect(users).toContainText('of 20');await expect(page.locator('.usage-summary article').filter({has:page.getByText('Connectors',{exact:true})})).toContainText('1 of 10');
 await expect(page.getByText('Whether tool connectors are priced like data sources is still being decided; they are counted separately either way.')).toBeVisible();
 await withTenant(setup,tenant.tenantId,db=>db.query('UPDATE core.tenants SET user_allowance=NULL WHERE tenant_id=$1',[tenant.tenantId]));
 await page.reload();await expect(page.getByText('Active users · no user allowance in your plan')).toBeVisible();
 await withTenant(setup,tenant.tenantId,db=>db.query('UPDATE core.tenants SET user_allowance=20 WHERE tenant_id=$1',[tenant.tenantId]));await page.reload();
 const {mkdirSync}=await import('node:fs');const {resolve}=await import('node:path');const {pathToFileURL}=await import('node:url');
 mkdirSync('docs/acceptance/phase5/prototype',{recursive:true});await page.setViewportSize({width:1440,height:900});await expect(users).toContainText('of 20');await page.screenshot({path:'docs/acceptance/phase5/usage.png'});
 const prototype=await browser.newPage({viewport:{width:1440,height:900}});
 try{await prototype.goto(pathToFileURL(resolve('docs/prototype/index.html')).href);await prototype.getByRole('button',{name:'Sign in',exact:true}).click();await prototype.evaluate('go("usage")');await expect(prototype.getByRole('heading',{name:'Usage'})).toBeVisible();await prototype.screenshot({path:'docs/acceptance/phase5/prototype/usage.png'});}
 finally{await prototype.close();}
});

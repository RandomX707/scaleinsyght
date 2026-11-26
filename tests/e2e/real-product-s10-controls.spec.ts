import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import 'dotenv/config';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';
import { activateAndWait } from '../support/e2e-profile.js';

const platformUrl=new URL(process.env.DATABASE_URL_MIGRATE??'');
platformUrl.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;
const pool=new Pool({connectionString:platformUrl.toString()});
const source=new URL(process.env.DATABASE_URL_TESTBED??'');

test('controls_exclusion_blocks_profile_and_query_after_approval',async({page,browser})=>{
  const tenantId=`controls-${randomUUID()}`;
  const email=`${tenantId}@example.test`;
  const password='controls-acceptance-password';
  await createTenant(pool,{tenantId,name:'Controls walkthrough',displayName:'Reviewer',email,password});
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`/login?tenant=${tenantId}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:/Reviewer/})).toBeVisible();
  const draft=await page.request.post('/api/connections',{data:{connectorType:'postgres',displayName:'PostgreSQL testbed',
    credential:{host:source.hostname,port:Number(source.port||5432),database:source.pathname.slice(1),username:decodeURIComponent(source.username),password:decodeURIComponent(source.password),sslMode:'disable'}}});
  expect(draft.status()).toBe(201);
  const {connectionId}=await draft.json() as {connectionId:string};
  await activateAndWait(page, connectionId);

  await page.goto('/');
  await page.getByLabel('Ask a question').fill('How many patients are in the PostgreSQL testbed?');
  await page.getByRole('button',{name:'Send question'}).click();
  await expect(page.getByText('Source result: 500',{exact:true})).toBeVisible({timeout:90_000});
  await page.getByRole('button',{name:'Useful',exact:true}).click();
  await page.getByRole('button',{name:'Save this question'}).click();
  await expect(page.getByRole('status').filter({hasText:'Saved.'})).toBeVisible();

  mkdirSync('docs/acceptance/s10',{recursive:true});
  await page.goto(`/controls?connection=${connectionId}`);
  await expect(page.getByText('Changes need approval',{exact:true})).toBeVisible();
  await page.locator('.control-toggle').filter({hasText:'Tables'}).click();
  await page.getByLabel('Override for public.patients').selectOption('exclude');
  await page.getByLabel('Pattern',{exact:true}).fill('public.*_backup');
  await page.getByRole('button',{name:'Add rule',exact:true}).click();
  await page.getByLabel('Column',{exact:true}).fill('public.encounters.patient_id');
  await page.getByRole('button',{name:'Add column rule'}).click();
  await expect(page.getByText('3 unsaved changes',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Unsaved changes'})).toContainText('1 single-object override (public.patients: exclude) · name rules changed (1 now) · column rules changed (1 now)');
  await page.screenshot({path:'docs/acceptance/s10/controls-changes.png'});
  await page.getByRole('button',{name:'Send for approval'}).click();
  await expect(page.getByRole('status').filter({hasText:'Sent to the Approval matrix'})).toBeVisible();
  await page.goto('/approval-matrix');
  await page.getByRole('button',{name:'Approve controls'}).click();
  await expect(page.getByRole('button',{name:'Approve controls'})).toHaveCount(0);

  await page.goto('/my-agent');
  const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&/\/saved-questions\/[^/]+\/start$/.test(new URL(response.url()).pathname));
  await page.getByRole('button',{name:'Start from this question'}).click();
  const started=await submitted;
  expect(started.status()).toBe(201);
  const runs=await withTenant(pool,tenantId,db=>db.query<{run_id:string;conversation_id:string}>(
    'SELECT run_id,conversation_id FROM runs.runs WHERE tenant_id=$1 ORDER BY created_at DESC',[tenantId]));
  expect(runs.rows).toHaveLength(2);
  const runId=runs.rows[0]!.run_id;const conversationId=runs.rows[0]!.conversation_id;
  await expect.poll(async()=>((await (await page.request.get(`/api/runs/${runId}`)).json()) as {state:string}).state).toBe('FAILED');
  const results=await withTenant(pool,tenantId,db=>db.query('SELECT 1 FROM runs.analytic_results WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId]));
  expect(results.rowCount).toBe(0);
  // The answer says plainly that the table is excluded in Controls, not a generic failure.
  await page.goto(`/conversations/${conversationId}`);
  await expect(page.getByText('public.patients is excluded in Controls, so it was not queried. An admin can change this in Controls.',{exact:true})).toBeVisible();
  await expect(page.getByText('I couldn’t answer this question from the selected sources.')).toHaveCount(0);

  await page.goto('/approval-matrix');
  await page.getByRole('button',{name:'Run a refresh now'}).click();
  await expect(page.locator('.nightly-summary')).toContainText('1 source refreshed');
  const checked=await withTenant(pool,tenantId,db=>db.query(
    `SELECT o.scope_mode,o.state,o.asset_id FROM profiler.job_objects o JOIN profiler.jobs j USING(tenant_id,job_id)
      WHERE o.tenant_id=$1 AND j.connection_id=$2 AND j.job_type='nightly' AND o.object_name='public.patients'
      ORDER BY j.created_at DESC LIMIT 1`,[tenantId,connectionId]));
  expect(checked.rows).toEqual([{scope_mode:'exclude',state:'SKIPPED',asset_id:null}]);
  const assets=await withTenant(pool,tenantId,db=>db.query(
    "SELECT active FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND qualified_name='public.patients'",[tenantId,connectionId]));
  expect(assets.rows).toEqual([{active:false}]);

  await page.goto(`/controls?connection=${connectionId}`);
  await expect(page.getByRole('heading',{name:'What to include'})).toBeVisible();
  await page.screenshot({path:'docs/acceptance/s10/controls.png'});
  const prototype=await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await prototype.goto(pathToFileURL(resolve('docs/prototype/index.html')).href);
    await prototype.getByRole('button',{name:'Sign in',exact:true}).click();
    await prototype.evaluate('go("controls")');
    await expect(prototype.getByRole('heading',{name:'What to include'})).toBeVisible();
    mkdirSync('docs/acceptance/s10/prototype',{recursive:true});
    await prototype.screenshot({path:'docs/acceptance/s10/prototype/controls.png'});
  }finally{await prototype.close();}
});

test.afterAll(async()=>{await pool.end();});

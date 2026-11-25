import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';
import { createDisposableSqlServerWriter } from '../support/sqlserver-writer.js';

config({ path: '.env' });
const tenantUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for local S2 acceptance.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: tenantUrl() });
const round6=(rows:Array<{providerId:number;average:number}>)=>rows.map(row=>({providerId:row.providerId,average:Math.round(row.average*1e6)/1e6}));
const truth=JSON.parse(readFileSync('testbed/truth.json','utf8')) as {answerChecks:{emergencyVisits2025:{sqlServer:number};ordersPerDepartmentTop5:{sqlServer:Array<{departmentName:string;orderCount:number}>};averageEncountersPerPatientByProvider:{sqlServer:Array<{providerId:number;average:number}>};patientCountComparison:{postgres:number;sqlServer:number};patientsWithPhone:{postgres:number;sqlServer:number}};expectedRelationships:{sqlServer:Array<{from:string;to:string;evidenceMethod:string;confidence:number}>}};
const required = ['SQLSERVER_TESTBED_HOST','SQLSERVER_TESTBED_PORT','SQLSERVER_TESTBED_DATABASE','SQLSERVER_TESTBED_USERNAME','SQLSERVER_TESTBED_PASSWORD'] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`${missing.join(', ')} required; run pnpm testbed:sqlserver:up. SQL Server E2E tests are never skipped.`);

test('s2_empty_tenant_adds_real_sql_server_profiles_and_relationships', async ({ page }) => {
  test.setTimeout(360_000);
  mkdirSync('docs/acceptance/s2', { recursive: true });
  const slug = `s2-${randomUUID()}`; const email = `reviewer@${slug}.test.invalid`; const password = 's2-testbed-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId: slug, name: 'SQL Server test workspace', displayName: 'Test Analyst', email, password });
  await page.goto(`/login?tenant=${slug}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();
  const remoteTrustOverride = await page.request.post('/api/connections', { data: { connectorType: 'sql_server', displayName: 'Remote certificate override', credential: { host: 'sql.example.invalid', port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } } });
  expect(remoteTrustOverride.status()).toBe(400); expect(await remoteTrustOverride.json()).toMatchObject({ error: 'sqlserver_certificate_override_local_only' });
  const writerCredential = createDisposableSqlServerWriter();
  try {
    const draft = await page.request.post('/api/connections', { data: { connectorType: 'sql_server', displayName: 'Writable role must be refused', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: writerCredential.username, password: writerCredential.password, trustServerCertificate: true } } });
    expect(draft.status()).toBe(201);
    const draftId = (await draft.json() as { connectionId: string }).connectionId;
    const refused = await page.request.post(`/api/connections/${draftId}/test`);
    expect(refused.status()).toBe(400); expect(await refused.json()).toMatchObject({ error: 'sqlserver_connector_role_not_read_only' });
  } finally { writerCredential.remove(); }
  await page.goto('/connectors'); await expect(page.getByText(/No sources connected/)).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s2/empty-connectors.png', fullPage: true });
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByLabel('Source type').selectOption('sql_server');
  await page.getByLabel('Connection name').fill('SQL Server hospital');
  await page.getByLabel('Host').fill(process.env.SQLSERVER_TESTBED_HOST!);
  await page.getByLabel('Port').fill(process.env.SQLSERVER_TESTBED_PORT!);
  await page.getByLabel('Database').fill(process.env.SQLSERVER_TESTBED_DATABASE!);
  await page.getByLabel('Username').fill(process.env.SQLSERVER_TESTBED_USERNAME!);
  await page.getByLabel('Password').fill(process.env.SQLSERVER_TESTBED_PASSWORD!);
  await page.getByLabel('Trust server certificate').check();
  await page.screenshot({ path: 'docs/acceptance/s2/add-sql-server.png', fullPage: true });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('heading', { name: 'Choose scope' })).toBeVisible();
  await page.getByRole('button', { name: 'Start profiling' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery complete' })).toBeVisible();
  const response = await page.request.get('/api/connections'); expect(response.ok()).toBeTruthy();
  const connections = (await response.json() as { connections: Array<{ connectionId: string; connectorType: string; status: string; agentId: string | null }> }).connections;
  const source = connections.find((item) => item.status === 'active' && item.connectorType === 'sql_server'); expect(source).toBeTruthy();
  expect(source!.agentId).toBeTruthy();
  const connectionId = source!.connectionId;
  const savedSecret = await withTenant(adminPool, slug, (client) => client.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM registry.connection_secrets WHERE tenant_id=$1 AND connection_id=$2 ORDER BY secret_version DESC LIMIT 1', [slug, connectionId]));
  expect(savedSecret.rows[0]?.ciphertext.length).toBeGreaterThan(16); expect(savedSecret.rows[0]?.ciphertext.equals(Buffer.from(process.env.SQLSERVER_TESTBED_PASSWORD!))).toBe(false);
  await page.goto(`/profile/${connectionId}`);
  await expect(page.getByText('Objects profiled')).toBeVisible(); await expect(page.locator('.profile-stats div').filter({ hasText: 'Objects profiled' }).locator('strong')).toHaveText('7');
  await expect(page.getByText(/patients\.name/)).toBeVisible(); await page.screenshot({ path: 'docs/acceptance/s2/profile.png', fullPage: true });
  const erResponse=await page.request.get(`/api/connections/${connectionId}/er`);expect(erResponse.ok()).toBeTruthy();const erData=await erResponse.json() as {relationships:Array<{from_name:string;to_name:string;evidence_method:string;confidence_score:number}>;tables:Array<{qualified_name:string;object_type:string;columns:Array<{name:string;data_type:string}>}>};expect(erData.relationships.map(item=>({from:item.from_name,to:item.to_name,evidenceMethod:item.evidence_method,confidence:Number(item.confidence_score)})).sort((a,b)=>a.from.localeCompare(b.from))).toEqual([...truth.expectedRelationships.sqlServer].sort((a,b)=>a.from.localeCompare(b.from)));expect(erData.relationships).toHaveLength(6);expect(erData.tables.find(item=>item.qualified_name==='dbo.department_order_summary')?.object_type).toBe('view');expect(erData.tables.find(item=>item.qualified_name==='dbo.patients')?.columns.some(column=>column.name.endsWith('.patient_id')&&column.data_type)).toBe(true);
  await page.getByRole('button', { name: 'Explore relationships' }).click();
  await expect(page.getByText('6 relationships')).toBeVisible();await expect(page.getByRole('heading',{name:'dbo.department_order_summary',exact:true})).toHaveCSS('text-transform','none');await expect(page.locator('.er-node--view').first()).toHaveCSS('border-top-style','dashed');await expect(page.locator('.er-link--inferred')).toHaveCount(4);await page.screenshot({ path: 'docs/acceptance/s2/er-inferred.png', fullPage: true });
  // Decision 38: possible relationships below 0.90 appear only on request, each marked low confidence; none are used in answers.
  const possible = page.getByLabel('Show possible relationships');
  await expect(possible).not.toBeChecked(); await possible.check();
  await expect(page.getByText('Declared foreign keys, inferred links above 0.90 confidence, and possible links below it, marked low confidence.')).toBeVisible();
  const lowConfidence = await page.locator('.er-link--possible').count();
  await expect(page.getByText(`${6 + lowConfidence} relationships`)).toBeVisible();
  for (let index = 0; index < lowConfidence; index++) await expect(page.locator('.er-link--possible text').nth(index)).toHaveText(/^Low confidence · /);
  await possible.uncheck(); await expect(page.getByText('6 relationships')).toBeVisible();
  await page.goto(`/dictionary?connection=${connectionId}`);
  await expect(page.locator('.dictionary-list summary').filter({ hasText: 'dbo.patients' })).toBeVisible();
  await expect(page.getByRole('button',{name:'Choose file'})).toBeVisible();
  await page.getByLabel('Import dictionary file').setInputFiles('testbed/s2-dictionary.csv');
  await expect(page.getByRole('status')).toContainText('1 descriptions imported.');

  await page.getByRole('tab', { name: /Procedures/ }).click();
  await expect(page.locator('summary').filter({ hasText: /dbo\.count_patient_encounters/ })).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s2/dictionary-procedures.png', fullPage: true });
  await page.goto('/'); await page.getByLabel('Ask a question').fill('How many patients are in SQL Server hospital?'); await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByText('Source result: 500', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Executed on SQL Server hospital; returned 1 aggregate row/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'How this was answered'})).toBeVisible();
  await page.getByText('Model and typed plan',{exact:true}).click();await expect(page.getByText(/Plan model:/)).toBeVisible();await expect(page.getByText(/Answer model:/)).toBeVisible();
  await expect(page.getByLabel('Ask a question')).toHaveValue('');await expect(page).toHaveURL(/\/conversations\//);
  const recent=page.locator('.recent-list button').filter({hasText:'How many patients are in SQL Server hospital?'});await expect(recent).toBeVisible();await recent.click();await expect(page.getByText('Source result: 500',{exact:true})).toBeVisible();
  const followUpPost=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST',{timeout:15_000});
  await page.getByLabel('Ask a question').fill('and how many of them have a phone number?');
  await page.getByRole('button',{name:'Send question'}).click();
  const submitted=await followUpPost;expect(submitted.status(),JSON.stringify(await submitted.json())).toBe(201);
  await expect(page.locator('.question-bubble')).toHaveCount(2);
  await expect(page.locator('.evidence-list').last()).toContainText(/phone.*IS NOT NULL/i,{timeout:60_000});
  await expect(page.locator('.answer-claim').last()).toContainText(String(truth.answerChecks.patientsWithPhone.sqlServer));
  await page.reload();await expect(page.locator('.question-bubble')).toHaveCount(2);
  await page.screenshot({ path: 'docs/acceptance/s2/home-answer.png', fullPage: true });
  await page.getByRole('button',{name:'New chat'}).click();
  await expect(page.locator('.question-bubble')).toHaveCount(0);
  await recent.click();
  await expect(page.locator('.question-bubble')).toHaveCount(2);
  const postgres=new URL(process.env.DATABASE_URL_TESTBED!);
  await page.goto('/connectors');
  await page.locator('.page-heading').getByRole('button',{name:/Add connector/}).click();
  await page.getByLabel('Connection name').fill('PostgreSQL testbed');
  await page.getByLabel('Host').fill(postgres.hostname);
  await page.getByLabel('Port').fill(postgres.port||'5432');
  await page.getByLabel('Database').fill(postgres.pathname.slice(1));
  await page.getByLabel('Username').fill(decodeURIComponent(postgres.username));
  await page.getByLabel('Password').fill(decodeURIComponent(postgres.password));
  await page.getByLabel('SSL mode').selectOption('disable');
  await page.getByRole('button',{name:'Test connection'}).click();
  await page.getByRole('button',{name:'Start profiling'}).click();
  await expect(page.getByRole('heading',{name:'Discovery complete'})).toBeVisible();
  await page.getByRole('button',{name:'Close dialog'}).click();
  type Captured={state:string;modelProvenance:Array<{purpose:string;model:string;inputTokens:number;outputTokens:number;typedPlan:unknown}>;answer:{answer:{claims:Array<{statement:string}>;evidence:Array<{locator:string}>;bySource:Array<{connectorType:string;value:number;rows?:Array<{group_value:string;value:number}>}>}}};
  async function askChecked(question:string,expectedSources:number,sql:RegExp,trigger?:()=>Promise<void>){
    const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST',{timeout:15_000});
    if(trigger)await trigger();else{await page.getByLabel('Ask a question').fill(question);await page.getByRole('button',{name:'Send question'}).click();}
    const response=await responsePromise;
    expect(response.status(),`${question}: ${JSON.stringify(await response.json())}`).toBe(201);
    const {runId}=await response.json() as {runId:string};
    let run:Captured|undefined;
    await expect.poll(async()=>{const detail=await page.request.get(`/api/runs/${runId}`);run=await detail.json() as Captured;return run.state;},{timeout:60_000}).toBe('COMPLETED');
    expect(run!.modelProvenance.map(call=>call.purpose)).toEqual(['plan','answer']);
    for(const call of run!.modelProvenance){expect(call.model).toBeTruthy();expect(call.inputTokens).toBeGreaterThan(0);expect(call.outputTokens).toBeGreaterThan(0);}
    expect(run!.modelProvenance[0]!.typedPlan).toBeTruthy();
    const answer=run!.answer.answer;
    expect(answer.bySource).toHaveLength(expectedSources);
    expect(answer.claims).toHaveLength(1);
    expect(answer.evidence).toHaveLength(expectedSources);
    for(const evidence of answer.evidence)expect(evidence.locator).toMatch(sql);
    await expect(page.locator('.answer-claim').last()).toHaveText(answer.claims[0]!.statement);
    const sourceLine=page.locator('.answer-sources').last();await expect(sourceLine).toContainText(expectedSources>1?'Sources used:':'Source used:');
    for(const name of answer.bySource.map(result=>result.connectorType==='sql_server'?'SQL Server hospital':'PostgreSQL testbed'))await expect(sourceLine).toContainText(name);
    const evidenceRows=page.locator('.evidence-list').last().locator(':scope > div');await expect(evidenceRows).toHaveCount(expectedSources);
    for(let index=0;index<expectedSources;index++){await expect(evidenceRows.nth(index)).toContainText('SELECT');expect((await evidenceRows.nth(index).innerText()).match(/· SELECT/g)).toHaveLength(1);}
    expect(await page.locator('.evidence-list').last().innerText()).not.toContain('<br');
    return {question,answer,provenance:run!.modelProvenance};
  }
  const answerTruth=truth.answerChecks as unknown as {ordersPerDepartment:{sqlServer:Array<{departmentName:string;orderCount:number}>};emergencyVisits2025:{sqlServer:number}};
  const singles=[
    ['How many encounters were emergency visits in 2025?',/JOIN.*admitted_at/i],
    ['Orders per department, top 5',/GROUP BY.*ORDER BY/i],
    ['How many orders does each department have?',/GROUP BY/i],
    ['Average number of encounters per patient by provider',/AVG.*patient_id/i],
  ] as const;
  const evidence=[];
  for(const [question,sql] of singles){
    await page.getByRole('button',{name:'New chat'}).click();
    await page.getByText('All sources',{exact:true}).click();
    await page.getByLabel('PostgreSQL testbed',{exact:true}).uncheck();
    evidence.push(await askChecked(question,1,sql));
    if(question.startsWith('Orders per department')){
      const top=truth.answerChecks.ordersPerDepartmentTop5.sqlServer;
      expect(new Set(top.map(row=>row.orderCount)).size).toBe(5);
      expect(evidence.at(-1)!.answer.bySource[0]!.rows?.map(row=>({departmentName:row.group_value,orderCount:Number(row.value)}))).toEqual(top.map(({departmentName,orderCount})=>({departmentName,orderCount})));
      const statement=evidence.at(-1)!.answer.claims[0]!.statement;
      for(const value of [top[0]!.orderCount,top[4]!.orderCount,top[0]!.orderCount-top[4]!.orderCount])expect(statement).toContain(value.toLocaleString('en-US'));
      await expect(page.locator('.bar-chart').last().locator('.bar-row')).toHaveCount(5);
      await expect(page.locator('.bar-chart').last().locator('.bar-label')).toHaveText(top.map(row=>row.departmentName));
      await expect(page.locator('.grouped-result').last().locator('tbody tr')).toHaveCount(5);
      await expect(page.locator('.group-summary').last()).toContainText(`Highest: ${top[0]!.departmentName} (${top[0]!.orderCount})`);
      await page.screenshot({path:'docs/acceptance/s2/home-group-by.png',fullPage:true});
    }
    if(question.startsWith('How many orders does each')){
      const all=answerTruth.ordersPerDepartment.sqlServer;
      const rows=evidence.at(-1)!.answer.bySource[0]!.rows?.map(row=>({departmentName:row.group_value,orderCount:Number(row.value)}));
      expect([...rows??[]].sort((a,b)=>b.orderCount-a.orderCount||a.departmentName.localeCompare(b.departmentName))).toEqual([...all].sort((a,b)=>b.orderCount-a.orderCount||a.departmentName.localeCompare(b.departmentName)).map(({departmentName,orderCount})=>({departmentName,orderCount})));
      const counts=all.map(row=>row.orderCount);const tied=counts.filter((value,index)=>counts.indexOf(value)!==index);
      expect(tied.length).toBeGreaterThan(0);
      const statement=evidence.at(-1)!.answer.claims[0]!.statement;
      expect(statement).toMatch(/\btie[sd]?\b/i);for(const value of tied)expect(statement).toContain(String(value));
      const tiedNames=all.filter(row=>tied.includes(row.orderCount)).map(row=>row.departmentName);
      for(const name of tiedNames)await expect(page.locator('.group-summary').last()).toContainText(name);
      await expect(page.locator('.bar-chart').last().locator('.bar-row')).toHaveCount(all.length);
      await expect(page.locator('.grouped-result').last().locator('tbody tr')).toHaveCount(all.length);
    }
    if(question.startsWith('Average number')){
      await expect(page.locator('.grouped-result').last().locator('.bar-chart')).toHaveCount(0);
      await expect(page.locator('.grouped-result').last().locator('tbody tr')).toHaveCount(truth.answerChecks.averageEncountersPerPatientByProvider.sqlServer.length);
    }
  }
  expect(evidence[0]!.answer.bySource[0]!.value).toBe(answerTruth.emergencyVisits2025.sqlServer);
  expect(evidence[0]!.answer.claims[0]!.statement).toContain(String(answerTruth.emergencyVisits2025.sqlServer));
  expect(evidence[0]!.answer.claims[0]!.statement).not.toMatch(/does not confirm|cannot confirm|cannot determine|unknown/i);
  expect(round6(evidence[3]!.answer.bySource[0]!.rows?.map(row=>({providerId:Number(row.group_value),average:Number(row.value)}))??[])).toEqual(round6(truth.answerChecks.averageEncountersPerPatientByProvider.sqlServer));
  await page.getByRole('button',{name:'New chat'}).click();
  await page.getByLabel('Ask a question').fill('How many encounters were emergency visits in 2025?');
  const choicePost=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST',{timeout:15_000});
  await page.getByRole('button',{name:'Send question'}).click();
  expect((await choicePost).status()).toBe(201);
  await expect(page.getByRole('heading',{name:'Which source should I use?'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Use PostgreSQL testbed'})).toBeVisible();
  await page.screenshot({path:'docs/acceptance/s2/home-source-choice.png',fullPage:true});
  const chosen=await askChecked('How many encounters were emergency visits in 2025?',1,/JOIN.*admitted_at/i,()=>page.getByRole('button',{name:'Use SQL Server hospital'}).click());
  expect(chosen.answer.bySource[0]!.value).toBe(answerTruth.emergencyVisits2025.sqlServer);
  await page.getByRole('button',{name:'New chat'}).click();
  const comparison=await askChecked('Do the PostgreSQL and SQL Server testbeds have the same number of patients?',2,/patients/i);
  const bySourceType=(captured:{answer:Captured['answer']['answer']})=>({postgres:captured.answer.bySource.find(result=>result.connectorType==='postgres')?.value,sqlServer:captured.answer.bySource.find(result=>result.connectorType==='sql_server')?.value});
  expect(bySourceType(comparison)).toEqual({postgres:truth.answerChecks.patientCountComparison.postgres,sqlServer:truth.answerChecks.patientCountComparison.sqlServer});
  const phone=await askChecked('and how many of them have a phone number?',2,/phone.*IS NOT NULL/i);
  expect(bySourceType(phone)).toEqual(truth.answerChecks.patientsWithPhone);
  for(const value of Object.values(truth.answerChecks.patientsWithPhone))expect(phone.answer.claims[0]!.statement).toContain(String(value));
  expect(phone.answer.claims[0]!.statement).not.toMatch(/every patient|all patients/i);
  for(const captured of [comparison,phone])for(const name of ['SQL Server hospital','PostgreSQL testbed'])expect(captured.answer.claims[0]!.statement).toContain(name);
  writeFileSync('docs/acceptance/s2/answer-evidence.json',JSON.stringify([...evidence,chosen,comparison,phone].map(({question,answer,provenance})=>({question,answer:answer.claims[0]!.statement,sql:answer.evidence.map(item=>item.locator),results:answer.bySource.map(result=>({connectorType:result.connectorType,value:result.value,rows:result.rows})),provenance})),null,2)+'\n');

});

test.afterAll(async () => { await adminPool.end(); });

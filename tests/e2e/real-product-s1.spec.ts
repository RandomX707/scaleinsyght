import { test,expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';

config({path:'.env'});
const tenantUrl=(key:'DATABASE_URL_MIGRATE')=>{const value=process.env[key];if(!value)throw new Error(`${key} is required for local testbed acceptance.`);const url=new URL(value);url.pathname='/si_test';return url.toString();};
const adminPool=new Pool({connectionString:tenantUrl('DATABASE_URL_MIGRATE')});
const databaseUrl=new URL(process.env.DATABASE_URL_TESTBED??'');if(!databaseUrl.hostname)throw new Error('Run pnpm testbed:up before the real-product walkthrough.');
const credentials={host:databaseUrl.hostname,port:Number(databaseUrl.port||5432),database:decodeURIComponent(databaseUrl.pathname.slice(1)),username:decodeURIComponent(databaseUrl.username),password:decodeURIComponent(databaseUrl.password)};

test('s1_empty_tenant_adds_real_postgres_profiles_metadata_and_answers_with_evidence',async({page})=>{
  mkdirSync('docs/acceptance/s1',{recursive:true});
  const tenantId=`real-product-${randomUUID()}`;const email=`analyst@${tenantId}.test.invalid`;const password='testbed-walkthrough-password-2026';
  await createTenant(adminPool,{tenantId,name:'Testbed hospital workspace',displayName:'Test Analyst',email,password});
  await page.goto(`/login?tenant=${tenantId}`);await page.getByLabel('Workspace ID').fill(tenantId);await page.getByLabel('Email').fill(email);await page.getByLabel('Password').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'What would you like to understand?'})).toBeVisible();
  await page.getByRole('button',{name:/Test Analyst/}).click();await page.getByRole('menuitem',{name:'Invite members'}).click();await expect(page.getByRole('heading',{name:'Invite members'})).toBeVisible();await page.getByLabel('Email',{exact:true}).fill(`member@${tenantId}.test.invalid`);await page.getByRole('button',{name:'Create invite link'}).click();const inviteUrl=await page.getByLabel('Copyable invite link').inputValue();expect(new URL(inviteUrl).origin).toBe(new URL(page.url()).origin);expect(new URL(inviteUrl).pathname).toBe('/invite');const invitePage=await page.context().newPage();await invitePage.goto(inviteUrl);await invitePage.getByLabel('Your name').fill('Test Member');await invitePage.getByLabel('Create a password').fill('testbed-member-password-2026');await invitePage.getByRole('button',{name:'Accept invitation'}).click();await expect(invitePage.getByRole('heading',{name:'Workspace access ready'})).toBeVisible();await invitePage.close();
  await page.goto('/connectors');await expect(page.getByText(/No sources connected/)).toBeVisible();await page.screenshot({path:'docs/acceptance/s1/empty-connectors.png',fullPage:true});
  await page.getByRole('button',{name:'Add connector'}).click();await page.getByLabel('Connection name').fill('Testbed hospital');await page.getByLabel('Host').fill(credentials.host);await page.getByLabel('Port').fill(String(credentials.port));await page.getByLabel('Database').fill(credentials.database);await page.getByLabel('Username').fill(credentials.username);await page.getByLabel('Password').fill(credentials.password);await page.getByLabel('SSL mode').selectOption('disable');await page.getByRole('button',{name:'Test connection'}).click();
  await expect(page.getByRole('heading',{name:'Choose scope'})).toBeVisible();await page.getByRole('button',{name:'Start profiling'}).click();await expect(page.getByRole('heading',{name:'Discovery complete'})).toBeVisible();
  const active=await page.request.get('/api/connections');expect(active.ok()).toBeTruthy();const source=(await active.json() as {connections:Array<{connectionId:string;status:string}>}).connections.find(item=>item.status==='active');expect(source).toBeTruthy();const connectionId=source!.connectionId;
  await page.goto(`/profile/${connectionId}`);await expect(page.getByText('Sensitive field classifications')).toBeVisible();for(const field of ['public.patients.name','public.patients.date_of_birth','public.patients.mrn','public.patients.phone'])await expect(page.getByText(field,{exact:false})).toBeVisible();await page.screenshot({path:'docs/acceptance/s1/profile.png',fullPage:true});
  await page.getByRole('button',{name:'Show ER diagram'}).click();const inferredPatientEdge=page.locator('li').filter({hasText:'public.encounters.patient_id → public.patients.patient_id'});await expect(inferredPatientEdge).toBeVisible();await expect(inferredPatientEdge).toContainText('inferred');await page.screenshot({path:'docs/acceptance/s1/er.png',fullPage:true});
  await page.goto(`/dictionary?connection=${connectionId}`);await page.locator('input[type=file][accept=".csv,.xlsx"]').setInputFiles('testbed/dictionary.csv');await expect(page.getByText('Descriptions imported: 4 of')).toBeVisible();await page.screenshot({path:'docs/acceptance/s1/dictionary.png',fullPage:true});
  await page.getByRole('button',{name:'Functions and procedures'}).click();await expect(page.locator('summary').filter({hasText:'count_patient_encounters'})).toBeVisible();
  await page.goto('/');await page.getByLabel('Your question').fill('How many patients are in Testbed hospital?');await page.getByRole('button',{name:'Ask question'}).click();
  await expect(page.getByText('Testbed hospital: 500',{exact:true})).toBeVisible({timeout:120_000});await expect(page.getByText(/Executed on Testbed hospital; returned 1 aggregate row/)).toBeVisible();await expect(page.getByText(/SELECT count\(\*\)::text AS value FROM "public"\."patients"/)).toBeVisible();await page.screenshot({path:'docs/acceptance/s1/home-answer.png',fullPage:true});
});

test.afterAll(async()=>{await adminPool.end();});

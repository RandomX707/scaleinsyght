import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';

config({path:'.env'});
const testUrl=(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE')=>{const value=process.env[key];if(!value)throw new Error(`${key} is required; metadata contracts are never skipped`);const url=new URL(value);url.pathname='/si_test';return url.toString();};
const appPool=new Pool({connectionString:testUrl('DATABASE_URL')});const adminPool=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});
const tenantId=`metadata-real-${randomUUID()}`;const email=`admin@${tenantId}.synthetic.invalid`;const password='metadata-real-test-password';let server:Awaited<ReturnType<typeof buildTestServer>>;let cookie='';

describe('contract 6 real PostgreSQL metadata',()=>{
  beforeAll(async()=>{
    const key=Buffer.alloc(32,41).toString('base64');process.env.CONNECTION_SECRET_KEY=key;
    await withTenant(adminPool,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[tenantId,email,hashPassword(password),'Metadata User']);});
    server=await buildTestServer({pool:appPool,sessionSecret:'phase2-real-postgres-metadata-contract-secret-01234',testAccounts:[{tenantId,email}]});const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email,password}});cookie=String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async()=>{await server?.close();await appPool.end();await adminPool.end();delete process.env.CONNECTION_SECRET_KEY;});
  it('c6_testbed_profile_classifies_sensitive_fields_infers_undeclared_relationship_imports_dictionary_and_lists_routines',async()=>{
    const sourceUrl=new URL(process.env.DATABASE_URL_TESTBED??'');if(!sourceUrl.hostname)throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
    // Every table and view the read-only login can see, counted directly in the testbed (public plus the dbt analytics schema).
    const reader=new Pool({connectionString:sourceUrl.toString()});const visibleTables=Number((await reader.query<{n:string}>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).rows[0]!.n);await reader.end();
    expect(visibleTables).toBeGreaterThanOrEqual(7);
    const credentials={host:sourceUrl.hostname,port:Number(sourceUrl.port||5432),database:decodeURIComponent(sourceUrl.pathname.slice(1)),username:decodeURIComponent(sourceUrl.username),password:decodeURIComponent(sourceUrl.password),sslMode:'disable'};
    const draft=await server.inject({method:'POST',url:'/api/connections',headers:{cookie},payload:{connectorType:'postgres',displayName:'Hospital test source',credential:credentials}});expect(draft.statusCode).toBe(201);const id=draft.json<{connectionId:string}>().connectionId;
    const active=await server.inject({method:'POST',url:`/api/connections/${id}/activate`,headers:{cookie},payload:{scope:[]}});expect(active.statusCode).toBe(200);expect(active.json<{profile:{profiled:number}}>().profile.profiled).toBeGreaterThan(0);
    const profile=await server.inject({method:'GET',url:`/api/connections/${id}/profile`,headers:{cookie}});const classifications=profile.json<{classifications:Array<{qualified_name:string;sensitivity_tags:string[];sensitivity_evidence:Array<{detection:string}>}>}>().classifications;expect(classifications.flatMap(item=>item.sensitivity_evidence).filter(item=>item.detection==='inferred')).toEqual([]);expect(classifications.map(({qualified_name,sensitivity_tags})=>({qualified_name,sensitivity_tags}))).toEqual(expect.arrayContaining([{qualified_name:'public.patients.name',sensitivity_tags:['personal']},{qualified_name:'public.patients.date_of_birth',sensitivity_tags:['regulated']},{qualified_name:'public.patients.mrn',sensitivity_tags:['identifier']},{qualified_name:'public.patients.phone',sensitivity_tags:['personal']} ]));
    const er=await server.inject({method:'GET',url:`/api/connections/${id}/er`,headers:{cookie}});expect(er.statusCode).toBe(200);expect(er.json<{relationships:Array<{from_name:string;to_name:string;evidence_method:string}>}>().relationships).toEqual(expect.arrayContaining([expect.objectContaining({from_name:'public.encounters.patient_id',to_name:'public.patients.patient_id',evidence_method:'inferred'})]));
    const file=readFileSync('testbed/dictionary.csv');const imported=await server.inject({method:'POST',url:`/api/connections/${id}/dictionary/import`,headers:{cookie},payload:{format:'csv',filename:'dictionary.csv',contentBase64:file.toString('base64')}});expect(imported.statusCode).toBe(200);expect(imported.json()).toMatchObject({imported:4});
    const dictionary=await server.inject({method:'GET',url:`/api/connections/${id}/dictionary`,headers:{cookie}});expect(dictionary.statusCode).toBe(200);const body=dictionary.json<{summary:{tableCount:number;columnCount:number;documentedColumnCount:number};routines:Array<{kind:string;definition:string}>}>();expect(body.summary).toMatchObject({tableCount:visibleTables,documentedColumnCount:4});expect(body.summary.columnCount).toBeGreaterThan(20);expect(body.routines).toEqual(expect.arrayContaining([expect.objectContaining({kind:'function',definition:expect.stringContaining('count_patient_encounters')})]));
  });
});

import { afterAll, describe, expect, it, vi } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { OpenAIModelGateway, type FetchLike } from '@scaleinsyght/model-gateway';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'):string{const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const app=new Pool({connectionString:testUrl('DATABASE_URL')});const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});

describe('contract 7 OpenAI gateway disclosure and budget boundary',()=>{
  afterAll(async()=>{await app.end();await migrate.end();});
  it('c1_model_usage_and_budget_rows_are_tenant_isolated',async()=>{
    const tenantA=`model-usage-a-${crypto.randomUUID()}`;const tenantB=`model-usage-b-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantA,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantA]);await db.query("INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome) VALUES($1,gen_random_uuid(),'cheap','synthetic-test-model',10,2,0.0001,'completed')",[tenantA]);});
    await withTenant(migrate,tenantB,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantB]);});
    const crossTenant=await withTenant(app,tenantB,async(db)=>db.query('SELECT tenant_id FROM core.model_usage WHERE tenant_id=$1',[tenantA]));
    expect(crossTenant.rows).toEqual([]);
  });
  it('c7_openai_gateway_outbound_request_contains_only_disclosed_metadata_and_keyed_fingerprints',async()=>{
    const tenantId=`model-gateway-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);});
    let calls=0;let outgoing='';
    const fetcher:FetchLike=async(_url,init)=>{calls++;outgoing=String(init?.body??'');return new Response(JSON.stringify({choices:[{message:{content:'The approved aggregate metadata indicates a monthly trend.'}}],usage:{prompt_tokens:75,completion_tokens:14}}),{status:200,headers:{'content-type':'application/json'}});};
    const env={OPENAI_API_KEY:'synthetic-test-key-never-real',MODEL_BASE_URL:'https://gateway.invalid/v1',MODEL_CHEAP:'test-cheap',MODEL_DEFAULT:'test-strong',MODEL_DAILY_COST_CAP_USD:'2',IDENTIFIER_FINGERPRINT_KEY:'f'.repeat(48),MODEL_PRICING_JSON:JSON.stringify({'test-cheap':{inputPerMillionUsd:0.2,outputPerMillionUsd:0.8},'test-strong':{inputPerMillionUsd:1,outputPerMillionUsd:5}})} as NodeJS.ProcessEnv;
    const gateway=new OpenAIModelGateway(app,env,fetcher);
    const identifier='SYN-P-000001';
    const response=await gateway.complete({tenantId,alias:'cheap',question:`Compare encounters for patient code ${identifier}`,identifierValues:[identifier],metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters',columns:[{name:'patient_id',data_type:'integer',sensitivity:'identifier'},{name:'department_id',data_type:'integer'}],patient_code:identifier,comment:'Sample Person C-1042 sample.person@example.invalid'},descriptive:{},statistical:{},sensitivityTags:[]}});
    expect(response.text).toContain('aggregate metadata');
    const sent=JSON.parse(outgoing) as {model:string;max_completion_tokens?:number;max_tokens?:number;temperature?:number;messages:Array<{content:string}>};
    const payload=sent.messages[1]!.content;
    expect(calls).toBe(1);expect(sent.model).toBe('test-cheap');expect(sent.max_completion_tokens).toBe(1000);expect(sent.max_tokens).toBeUndefined();expect(sent.temperature).toBeUndefined();expect(payload).not.toContain(identifier);expect(payload).not.toContain('Sample Person');expect(payload).not.toContain('C-1042');expect(payload).not.toContain('sample.person@example.invalid');expect(payload).toContain('[redacted_identifier]');
    const captured=JSON.parse(payload) as {identifier_fingerprints:string[]};
    expect(captured.identifier_fingerprints).toHaveLength(1);expect(captured.identifier_fingerprints[0]).toMatch(/^[a-f0-9]{64}$/);
    const stored=await withTenant(migrate,tenantId,async(db)=>db.query<{model_alias:string;model_name:string;input_tokens:number;output_tokens:number;cost_usd:string;outcome:string}>('SELECT model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome FROM core.model_usage WHERE tenant_id=$1',[tenantId]));
    expect(stored.rows).toHaveLength(1);expect(stored.rows[0]).toMatchObject({model_alias:'cheap',model_name:'test-cheap',input_tokens:75,output_tokens:14,outcome:'completed'});
    expect((sent.messages[0] as {role?:string;content:string}).content).toContain('Do not infer hidden row values');
    await gateway.complete({tenantId,alias:'cheap',purpose:'plan',question:`Count encounters for patient code ${identifier}`,identifierValues:[identifier],metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters'},descriptive:{},statistical:{},sensitivityTags:[]}});
    const planned=JSON.parse(outgoing) as {messages:Array<{role:string;content:string}>;response_format?:{type:string}};
    expect(planned.response_format).toEqual({type:'json_object'});
    const planning=new OpenAIModelGateway(app,{...env,MODEL_PLANNING:'test-strong'},fetcher);
    await planning.complete({tenantId,alias:'planning',purpose:'verify',question:'Does this plan answer the question?',metadata:{classification:'METADATA_STRUCTURAL',structural:{plan:'count rows'},descriptive:{},statistical:{},sensitivityTags:[]}});
    const verifying=JSON.parse(outgoing) as {model:string;messages:Array<{content:string}>;response_format?:{type:string}};
    expect(verifying.model).toBe('test-strong');expect(verifying.messages[0]!.content).toContain('check whether a typed');expect(verifying.response_format).toEqual({type:'json_object'});expect((sent as {response_format?:unknown}).response_format).toBeUndefined();
    expect(planned.messages[0]).toMatchObject({role:'system'});expect(planned.messages[0]!.content).toContain('typed, read-only query plans');expect(planned.messages[0]!.content).not.toContain('Do not infer hidden row values');expect(planned.messages[1]!.content).not.toContain(identifier);

    const blockedFetcher=vi.fn(fetcher);
    const capped=new OpenAIModelGateway(app,{...env,MODEL_DAILY_COST_CAP_USD:'0.00000001'},blockedFetcher);
    await expect(capped.complete({tenantId,alias:'cheap',question:'Summarize safe structural metadata',metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters'},descriptive:{},statistical:{},sensitivityTags:[]}})).rejects.toMatchObject({code:'model_budget_daily_cap_reached'});
    expect(blockedFetcher).not.toHaveBeenCalled();
    const rejected=await withTenant(migrate,tenantId,async(db)=>db.query<{outcome:string;safe_error_code:string}>('SELECT outcome,safe_error_code FROM core.model_usage WHERE tenant_id=$1 AND outcome=\'budget_rejected\'', [tenantId]));
    expect(rejected.rows[0]).toEqual({outcome:'budget_rejected',safe_error_code:'model_budget_daily_cap_reached'});
  });

  it('c7_model_budget_reserves_a_conservative_utf8_request_size_before_calling_provider',async()=>{
    const tenantId=`model-budget-utf8-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);});
    let providerCalls=0;
    const env={OPENAI_API_KEY:'synthetic-test-key-never-real',MODEL_BASE_URL:'https://gateway.invalid/v1',MODEL_CHEAP:'test-cheap',MODEL_DEFAULT:'test-strong',MODEL_DAILY_COST_CAP_USD:'0.0005',IDENTIFIER_FINGERPRINT_KEY:'f'.repeat(48),MODEL_PRICING_JSON:JSON.stringify({'test-cheap':{inputPerMillionUsd:0.2,outputPerMillionUsd:0.8},'test-strong':{inputPerMillionUsd:1,outputPerMillionUsd:5}})} as NodeJS.ProcessEnv;
    const gateway=new OpenAIModelGateway(app,env,async()=>{providerCalls++;return new Response('{}',{status:200});});
    await expect(gateway.complete({tenantId,alias:'cheap',question:'患者'.repeat(500),maxOutputTokens:64,metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters'},descriptive:{},statistical:{},sensitivityTags:[]}})).rejects.toMatchObject({code:'model_budget_daily_cap_reached'});
    expect(providerCalls).toBe(0);
  });

  it('c7_model_budget_caps_each_person_within_the_tenant_daily_cap',async()=>{
    const tenantId=`model-budget-user-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);});
    const busy=crypto.randomUUID(),colleague=crypto.randomUUID();let calls=0;
    const env={OPENAI_API_KEY:'synthetic-test-key-never-real',MODEL_BASE_URL:'https://gateway.invalid/v1',MODEL_CHEAP:'test-cheap',MODEL_DEFAULT:'test-strong',MODEL_DAILY_COST_CAP_USD:'2',MODEL_DAILY_USER_COST_CAP_USD:'0.0002',IDENTIFIER_FINGERPRINT_KEY:'f'.repeat(48),MODEL_PRICING_JSON:JSON.stringify({'test-cheap':{inputPerMillionUsd:0.2,outputPerMillionUsd:0.8},'test-strong':{inputPerMillionUsd:1,outputPerMillionUsd:5}})} as NodeJS.ProcessEnv;
    const gateway=new OpenAIModelGateway(app,env,async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'A safe answer.'}}],usage:{prompt_tokens:600,completion_tokens:40}}),{status:200});});
    const ask=(principalId:string)=>gateway.complete({tenantId,principalId,alias:'cheap',question:'Summarize the safe schema',maxOutputTokens:64,metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters'},descriptive:{},statistical:{},sensitivityTags:[]}});
    await expect(ask(busy)).resolves.toMatchObject({text:'A safe answer.'});
    await expect(ask(busy)).rejects.toMatchObject({code:'model_budget_user_daily_cap_reached'});
    // The same tenant still serves a different person.
    await expect(ask(colleague)).resolves.toMatchObject({text:'A safe answer.'});
    expect(calls).toBe(2);
    const rows=await withTenant(migrate,tenantId,async(db)=>db.query<{principal_id:string;outcome:string;safe_error_code:string|null}>('SELECT principal_id,outcome,safe_error_code FROM core.model_usage WHERE tenant_id=$1 ORDER BY created_at',[tenantId]));
    expect(rows.rows).toEqual([{principal_id:busy,outcome:'completed',safe_error_code:null},{principal_id:busy,outcome:'budget_rejected',safe_error_code:'model_budget_user_daily_cap_reached'},{principal_id:colleague,outcome:'completed',safe_error_code:null}]);
  });

  it('c7_gateway_does_not_record_estimated_tokens_as_provider_usage',async()=>{
    const tenantId=`model-usage-missing-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);});
    const env={OPENAI_API_KEY:'synthetic-test-key-never-real',MODEL_BASE_URL:'https://gateway.invalid/v1',MODEL_CHEAP:'test-cheap',MODEL_DEFAULT:'test-strong',MODEL_DAILY_COST_CAP_USD:'2',IDENTIFIER_FINGERPRINT_KEY:'f'.repeat(48),MODEL_PRICING_JSON:JSON.stringify({'test-cheap':{inputPerMillionUsd:0.2,outputPerMillionUsd:0.8},'test-strong':{inputPerMillionUsd:1,outputPerMillionUsd:5}})} as NodeJS.ProcessEnv;
    const gateway=new OpenAIModelGateway(app,env,async()=>new Response(JSON.stringify({choices:[{message:{content:'A safe answer.'}}]}),{status:200}));
    await expect(gateway.complete({tenantId,alias:'cheap',question:'Summarize the safe schema',metadata:{classification:'METADATA_STRUCTURAL',structural:{qualified_name:'public.encounters'},descriptive:{},statistical:{},sensitivityTags:[]}})).rejects.toMatchObject({code:'model_provider_response_invalid'});
    const row=await withTenant(migrate,tenantId,async(db)=>db.query<{input_tokens:number;output_tokens:number;cost_usd:string;outcome:string}>('SELECT input_tokens,output_tokens,cost_usd,outcome FROM core.model_usage WHERE tenant_id=$1',[tenantId]));
    expect(row.rows[0]).toEqual({input_tokens:0,output_tokens:0,cost_usd:'0.00000000',outcome:'failed'});
  });
});

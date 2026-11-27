import { createHash, createHmac, randomUUID } from 'node:crypto';
import { prepareMetadataForModel, type ModelMetadataInput } from '@scaleinsyght/classification';
import { withTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';

export type ModelAlias='cheap'|'default'|'planning';
export type ModelPrice={inputPerMillionUsd:number;outputPerMillionUsd:number};
export type GatewayConfig={baseUrl:string;apiKey:string;cheapModel:string;defaultModel:string;planningModel:string;dailyCostCapUsd:number;dailyUserCostCapUsd:number;fingerprintKey:string;prices:Record<string,ModelPrice>};
export type GatewayRequest={tenantId:string;/** The person the call is made for; their own daily USD cap applies. */principalId?:string;alias:ModelAlias;question:string;metadata:ModelMetadataInput;identifierValues?:string[];maxOutputTokens?:number;purpose?:'answer'|'plan'|'verify'|'describe';responseSchema?:Record<string,unknown>};
const SYSTEM_INSTRUCTIONS={
  answer:'Answer only from the disclosed metadata. Do not infer hidden row values. If metadata is insufficient, say so.',
  verify:'You check whether a typed, read-only query plan answers a question exactly: the same subject, measure, grouping, conditions, ranking and sources. You never see row values. Respond with a single JSON object.',
  // Decision 66: plain-language Dictionary descriptions from structural metadata and scrubbed SQL only.
  describe:'You write short, plain descriptions of database objects for people who are not engineers, from disclosed metadata only: names, column names, keys and SQL with literal values hidden. You never see row values or statistics. Say what each object is or does in one or two sentences, in sentence case, without jargon or a list of tables. Respond with a single JSON object.',
  plan:'You write typed, read-only query plans from disclosed metadata. You never see row values, and you do not need to: a category, label or date named in the question is used as a filter value on the matching column, and is bound as a query parameter. Return an empty plan only when no table or column in the metadata can express the request. Never return SQL. Respond with a single JSON object.',
} as const;
export type GatewayResponse={text:string;requestId:string;model:string;inputTokens:number;outputTokens:number;costUsd:number};
export type FetchLike=(input:URL|string,init?:RequestInit)=>Promise<Response>;

export class ModelGatewayError extends Error {
  constructor(readonly code:string){super(code);this.name='ModelGatewayError';}
}

export function assertLiveModelTestAllowed(env:NodeJS.ProcessEnv):void{
  if(env.CI==='true'||env.GITHUB_ACTIONS==='true')throw new ModelGatewayError('test_live_is_local_only');
  if(env.LIVE_MODEL_TEST!=='1')throw new ModelGatewayError('LIVE_MODEL_TEST_opt_in_required');
}

function nonEmpty(value:string|undefined,key:string):string{if(!value?.trim())throw new ModelGatewayError(`${key}_required`);return value.trim();}
// Daily model budgets are USD caps (decision 43): per tenant, and per user within the tenant.
export const DEFAULT_TENANT_DAILY_COST_CAP_USD=5;
export const DEFAULT_USER_DAILY_COST_CAP_USD=1;
export function dailyBudgetCaps(env:NodeJS.ProcessEnv=process.env):{tenantUsd:number;userUsd:number}{
  return {tenantUsd:Number(env.MODEL_DAILY_COST_CAP_USD||DEFAULT_TENANT_DAILY_COST_CAP_USD),userUsd:Number(env.MODEL_DAILY_USER_COST_CAP_USD||DEFAULT_USER_DAILY_COST_CAP_USD)};
}
function readConfig(env:NodeJS.ProcessEnv):GatewayConfig{
  const baseUrl=(env.MODEL_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
  let prices:Record<string,ModelPrice>={};
  if(env.MODEL_PRICING_JSON){try{prices=JSON.parse(env.MODEL_PRICING_JSON) as Record<string,ModelPrice>;}catch{throw new ModelGatewayError('invalid_model_pricing_config');}}
  return {baseUrl,apiKey:nonEmpty(env.OPENAI_API_KEY,'OPENAI_API_KEY'),cheapModel:nonEmpty(env.MODEL_CHEAP,'MODEL_CHEAP'),defaultModel:nonEmpty(env.MODEL_DEFAULT,'MODEL_DEFAULT'),planningModel:env.MODEL_PLANNING||nonEmpty(env.MODEL_DEFAULT,'MODEL_DEFAULT'),dailyCostCapUsd:Number(env.MODEL_DAILY_COST_CAP_USD||DEFAULT_TENANT_DAILY_COST_CAP_USD),dailyUserCostCapUsd:Number(env.MODEL_DAILY_USER_COST_CAP_USD||DEFAULT_USER_DAILY_COST_CAP_USD),fingerprintKey:nonEmpty(env.IDENTIFIER_FINGERPRINT_KEY||env.ARTIFACT_MASTER_KEY,'IDENTIFIER_FINGERPRINT_KEY'),prices};
}

const sensitiveKey=/(?:raw_?values?|sample_?rows?|result_?rows?|patient_?name|email_?address|password|secret|credential)/i;
const safeValues=(value:unknown,key:string,rawIdentifiers:Set<string>):unknown=>{
  if(sensitiveKey.test(key)&&key!=='row_count')throw new ModelGatewayError('model_metadata_contains_raw_values');
  if(typeof value==='string'){
    let result=value;
    for(const identifier of rawIdentifiers)if(identifier)result=result.replaceAll(identifier,'[redacted_identifier]');
    result=result.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi,'[redacted]')
      .replace(/\bSYN-[A-Z]+-\d+\b/gi,'[redacted_identifier]')
      .replace(/\b[A-Z]-\d{4,}\b/g,'[redacted_identifier]')
      .replace(/\b[A-F0-9]{8}-[A-F0-9-]{27,}\b/gi,'[redacted_identifier]')
      .replace(/\b(?:patient|encounter|provider|account|member)\s*(?:id|code|number)\s*[:=#]?\s*[A-Z0-9-]+\b/gi,'[redacted_identifier]')
      .replace(/\b\d{8,}\b/g,'[redacted_identifier]');
    if(/comment|description|definition/i.test(key))result=prepareMetadataForModel({classification:'METADATA_DESCRIPTIVE',structural:{},descriptive:{text:result},statistical:{},sensitivityTags:[]}).descriptive?.text??'[redacted]';
    return result;
  }
  if(Array.isArray(value))return value.map(item=>safeValues(item,key,rawIdentifiers));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([child,nested])=>[child,safeValues(nested,child,rawIdentifiers)]));
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  throw new ModelGatewayError('model_metadata_invalid');
};

function fingerprint(key:string,tenantId:string,value:string):string{
  const tenantKey=createHmac('sha256',key).update('scale-insyght:model-fingerprint:v1\0').update(tenantId).digest();
  return createHmac('sha256',tenantKey).update(value).digest('hex');
}
function safeQuestion(question:string,rawIdentifiers:Set<string>):string{
  const scrubbed=prepareMetadataForModel({classification:'METADATA_DESCRIPTIVE',structural:{},descriptive:{question},statistical:{},sensitivityTags:[]}).descriptive?.question??'';
  return String(safeValues(scrubbed,'question',rawIdentifiers));
}
function requestId():string{return randomUUID();}
function utcBounds(now:Date):[Date,Date]{const start=new Date(now);start.setUTCHours(0,0,0,0);const end=new Date(start);end.setUTCDate(end.getUTCDate()+1);return[start,end];}
function estimateTokens(value:string):number{return Math.max(1,Buffer.byteLength(value,'utf8'));}
function priceFor(config:GatewayConfig,model:string):ModelPrice{
  const price=config.prices[model];if(!price||!Number.isFinite(price.inputPerMillionUsd)||!Number.isFinite(price.outputPerMillionUsd)||price.inputPerMillionUsd<0||price.outputPerMillionUsd<0)throw new ModelGatewayError('model_pricing_not_configured');
  return price;
}
function priceTokens(price:ModelPrice,input:number,output:number):number{return Number(((input*price.inputPerMillionUsd+output*price.outputPerMillionUsd)/1_000_000).toFixed(8));}

export class OpenAIModelGateway{
  private readonly config:GatewayConfig;
  constructor(private readonly pool:Pool,env:NodeJS.ProcessEnv=process.env,private readonly fetcher:FetchLike=fetch){this.config=readConfig(env);if(!Number.isFinite(this.config.dailyCostCapUsd)||this.config.dailyCostCapUsd<=0||!Number.isFinite(this.config.dailyUserCostCapUsd)||this.config.dailyUserCostCapUsd<=0)throw new ModelGatewayError('invalid_model_budget_config');}

  async complete(input:GatewayRequest):Promise<GatewayResponse>{
    if(!input.tenantId||input.question.length>4000||!input.question.trim())throw new ModelGatewayError('invalid_model_request');
    const model=input.alias==='cheap'?this.config.cheapModel:input.alias==='planning'?this.config.planningModel:this.config.defaultModel;
    const price=priceFor(this.config,model);
    const rawIdentifiers=new Set(input.identifierValues??[]);
    const prepared=prepareMetadataForModel(input.metadata);
    const safeMetadata=safeValues(prepared,'metadata',rawIdentifiers);
    const question=safeQuestion(input.question,rawIdentifiers);
    const fingerprints=[...rawIdentifiers].map(value=>fingerprint(this.config.fingerprintKey,input.tenantId,value));
    const maxOutputTokens=Math.min(2048,Math.max(64,input.maxOutputTokens??1000));
    const payload={model,messages:[{role:'system',content:SYSTEM_INSTRUCTIONS[input.purpose??'answer']},{role:'user',content:JSON.stringify({question,metadata:safeMetadata,identifier_fingerprints:fingerprints})}],max_completion_tokens:maxOutputTokens,...(input.purpose==='plan'||input.purpose==='verify'||input.purpose==='describe'?{response_format:input.responseSchema ? {type:'json_schema',json_schema:{name:input.purpose==='verify'?'plan_verification':input.purpose==='describe'?'dictionary_descriptions':'typed_analytic_plan',strict:true,schema:input.responseSchema}} : {type:'json_object'}}:{})};
    const body=JSON.stringify(payload);const estimatedInput=estimateTokens(body);const estimatedTokens=estimatedInput+maxOutputTokens;
    const reservedCost=priceTokens(price,estimatedInput,maxOutputTokens);const id=requestId();
    const reservation=await withTenant(this.pool,input.tenantId,async(client)=>{
      const dayKey=`${input.tenantId}:${new Date().toISOString().slice(0,10)}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[dayKey]);
      const [from,to]=utcBounds(new Date());
      // Spend today = recorded cost plus open reservations, for the tenant and (when known) for this person.
      const totals=await client.query<{tenant_cost:string;user_cost:string}>(`SELECT
        (COALESCE((SELECT sum(cost_usd) FROM core.model_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0)+COALESCE((SELECT sum(reserved_cost_usd) FROM core.model_budget_reservations WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0))::text AS tenant_cost,
        (COALESCE((SELECT sum(cost_usd) FROM core.model_usage WHERE tenant_id=$1 AND principal_id=$4 AND created_at >= $2 AND created_at < $3),0)+COALESCE((SELECT sum(reserved_cost_usd) FROM core.model_budget_reservations WHERE tenant_id=$1 AND principal_id=$4 AND created_at >= $2 AND created_at < $3),0))::text AS user_cost`,[input.tenantId,from,to,input.principalId??null]);
      const tenantCost=Number(totals.rows[0]!.tenant_cost),userCost=Number(totals.rows[0]!.user_cost);
      const rejected=tenantCost+reservedCost>this.config.dailyCostCapUsd?'model_budget_daily_cap_reached':input.principalId&&userCost+reservedCost>this.config.dailyUserCostCapUsd?'model_budget_user_daily_cap_reached':null;
      if(rejected){
        await client.query("INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome,safe_error_code,principal_id) VALUES($1,$2,$3,$4,0,0,0,'budget_rejected',$5,$6)",[input.tenantId,id,input.alias,model,rejected,input.principalId??null]);return rejected;
      }
      await client.query('INSERT INTO core.model_budget_reservations(tenant_id,request_id,estimated_tokens,reserved_cost_usd,principal_id) VALUES($1,$2,$3,$4,$5)',[input.tenantId,id,estimatedTokens,reservedCost,input.principalId??null]);return null;
    });
    if(reservation)throw new ModelGatewayError(reservation);
    try{
      const response=await this.fetcher(`${this.config.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${this.config.apiKey}`,'content-type':'application/json'},body,signal:AbortSignal.timeout(60_000)});
      if(!response.ok)throw new ModelGatewayError('model_provider_request_failed');
      const data=await response.json() as {choices?:Array<{message?:{content?:unknown}}>;usage?:{prompt_tokens?:number;completion_tokens?:number}};
      const text=typeof data.choices?.[0]?.message?.content==='string'?data.choices[0].message.content:null;
      const inputTokens=data.usage?.prompt_tokens,outputTokens=data.usage?.completion_tokens;
      if(text===null||typeof inputTokens!=='number'||typeof outputTokens!=='number'||!Number.isInteger(inputTokens)||!Number.isInteger(outputTokens)||inputTokens<0||outputTokens<0)throw new ModelGatewayError('model_provider_response_invalid');
      const costUsd=priceTokens(price,inputTokens,outputTokens);
      await withTenant(this.pool,input.tenantId,async(client)=>{
        await client.query('INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome,principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,\'completed\',$8)',[input.tenantId,id,input.alias,model,inputTokens,outputTokens,costUsd,input.principalId??null]);
        await client.query('DELETE FROM core.model_budget_reservations WHERE tenant_id=$1 AND request_id=$2',[input.tenantId,id]);
      });
      return {text,requestId:id,model,inputTokens,outputTokens,costUsd};
    }catch(error){
      const code=error instanceof ModelGatewayError?error.code:'model_provider_request_failed';
      await withTenant(this.pool,input.tenantId,async(client)=>{
        await client.query('INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome,safe_error_code,principal_id) VALUES($1,$2,$3,$4,0,0,0,\'failed\',$5,$6)',[input.tenantId,id,input.alias,model,code,input.principalId??null]);
        await client.query('DELETE FROM core.model_budget_reservations WHERE tenant_id=$1 AND request_id=$2',[input.tenantId,id]);
      });
      throw error instanceof ModelGatewayError?error:new ModelGatewayError(code);
    }
  }
}

export async function listOpenAIModels(env:NodeJS.ProcessEnv=process.env,fetcher:FetchLike=fetch):Promise<string[]>{
  const key=nonEmpty(env.OPENAI_API_KEY,'OPENAI_API_KEY');const base=(env.MODEL_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
  const response=await fetcher(`${base}/models`,{headers:{authorization:`Bearer ${key}`}});
  if(!response.ok)throw new ModelGatewayError(`model_catalog_request_failed_${response.status}`);
  const data=await response.json() as {data?:Array<{id?:unknown}>};
  return (data.data??[]).map(item=>item.id).filter((id):id is string=>typeof id==='string').sort();
}

export function safeMetadataDigest(metadata:unknown):string{return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');}

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { prepareMetadataForModel, type ModelMetadataInput } from '@scaleinsyght/classification';
import { withTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';

export type ModelAlias='cheap'|'default';
export type ModelPrice={inputPerMillionUsd:number;outputPerMillionUsd:number};
export type GatewayConfig={baseUrl:string;apiKey:string;cheapModel:string;defaultModel:string;dailyCostCapUsd:number;dailyTokenCap:number;fingerprintKey:string;prices:Record<string,ModelPrice>};
export type GatewayRequest={tenantId:string;alias:ModelAlias;question:string;metadata:ModelMetadataInput;identifierValues?:string[];maxOutputTokens?:number};
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
function readConfig(env:NodeJS.ProcessEnv):GatewayConfig{
  const baseUrl=(env.MODEL_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
  let prices:Record<string,ModelPrice>={};
  if(env.MODEL_PRICING_JSON){try{prices=JSON.parse(env.MODEL_PRICING_JSON) as Record<string,ModelPrice>;}catch{throw new ModelGatewayError('invalid_model_pricing_config');}}
  return {baseUrl,apiKey:nonEmpty(env.OPENAI_API_KEY,'OPENAI_API_KEY'),cheapModel:nonEmpty(env.MODEL_CHEAP,'MODEL_CHEAP'),defaultModel:nonEmpty(env.MODEL_DEFAULT,'MODEL_DEFAULT'),dailyCostCapUsd:Number(env.MODEL_DAILY_COST_CAP_USD??2),dailyTokenCap:Number(env.MODEL_DAILY_TOKEN_CAP??100_000),fingerprintKey:nonEmpty(env.IDENTIFIER_FINGERPRINT_KEY||env.ARTIFACT_MASTER_KEY,'IDENTIFIER_FINGERPRINT_KEY'),prices};
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
  constructor(private readonly pool:Pool,env:NodeJS.ProcessEnv=process.env,private readonly fetcher:FetchLike=fetch){this.config=readConfig(env);if(!Number.isFinite(this.config.dailyCostCapUsd)||this.config.dailyCostCapUsd<=0||!Number.isInteger(this.config.dailyTokenCap)||this.config.dailyTokenCap<=0)throw new ModelGatewayError('invalid_model_budget_config');}

  async complete(input:GatewayRequest):Promise<GatewayResponse>{
    if(!input.tenantId||input.question.length>4000||!input.question.trim())throw new ModelGatewayError('invalid_model_request');
    const model=input.alias==='cheap'?this.config.cheapModel:this.config.defaultModel;
    const price=priceFor(this.config,model);
    const rawIdentifiers=new Set(input.identifierValues??[]);
    const prepared=prepareMetadataForModel(input.metadata);
    const safeMetadata=safeValues(prepared,'metadata',rawIdentifiers);
    const question=safeQuestion(input.question,rawIdentifiers);
    const fingerprints=[...rawIdentifiers].map(value=>fingerprint(this.config.fingerprintKey,input.tenantId,value));
    const maxOutputTokens=Math.min(2048,Math.max(64,input.maxOutputTokens??1000));
    const payload={model,messages:[{role:'system',content:'Answer only from the disclosed metadata. Do not infer hidden row values. If metadata is insufficient, say so.'},{role:'user',content:JSON.stringify({question,metadata:safeMetadata,identifier_fingerprints:fingerprints})}],max_tokens:maxOutputTokens,temperature:0};
    const body=JSON.stringify(payload);const estimatedInput=estimateTokens(body);const estimatedTokens=estimatedInput+maxOutputTokens;
    const reservedCost=priceTokens(price,estimatedInput,maxOutputTokens);const id=requestId();
    const reservation=await withTenant(this.pool,input.tenantId,async(client)=>{
      const dayKey=`${input.tenantId}:${new Date().toISOString().slice(0,10)}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[dayKey]);
      const [from,to]=utcBounds(new Date());
      const totals=await client.query<{tokens:string;cost:string}>(`SELECT
        (COALESCE((SELECT sum(input_tokens+output_tokens) FROM core.model_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0)+COALESCE((SELECT sum(estimated_tokens) FROM core.model_budget_reservations WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0))::text AS tokens,
        (COALESCE((SELECT sum(cost_usd) FROM core.model_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0)+COALESCE((SELECT sum(reserved_cost_usd) FROM core.model_budget_reservations WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0))::text AS cost`,[input.tenantId,from,to]);
      const tokens=Number(totals.rows[0]!.tokens),cost=Number(totals.rows[0]!.cost);
      if(tokens+estimatedTokens>this.config.dailyTokenCap||cost+reservedCost>this.config.dailyCostCapUsd){
        await client.query("INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome,safe_error_code) VALUES($1,$2,$3,$4,0,0,0,'budget_rejected','model_budget_daily_cap_reached')",[input.tenantId,id,input.alias,model]);return false;
      }
      await client.query('INSERT INTO core.model_budget_reservations(tenant_id,request_id,estimated_tokens,reserved_cost_usd) VALUES($1,$2,$3,$4)',[input.tenantId,id,estimatedTokens,reservedCost]);return true;
    });
    if(!reservation)throw new ModelGatewayError('model_budget_daily_cap_reached');
    try{
      const response=await this.fetcher(`${this.config.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${this.config.apiKey}`,'content-type':'application/json'},body});
      if(!response.ok)throw new ModelGatewayError('model_provider_request_failed');
      const data=await response.json() as {choices?:Array<{message?:{content?:unknown}}>;usage?:{prompt_tokens?:number;completion_tokens?:number}};
      const text=typeof data.choices?.[0]?.message?.content==='string'?data.choices[0].message.content:null;
      const inputTokens=data.usage?.prompt_tokens,outputTokens=data.usage?.completion_tokens;
      if(text===null||!Number.isInteger(inputTokens)||!Number.isInteger(outputTokens)||inputTokens!<0||outputTokens!<0)throw new ModelGatewayError('model_provider_response_invalid');
      const costUsd=priceTokens(price,inputTokens,outputTokens);
      await withTenant(this.pool,input.tenantId,async(client)=>{
        await client.query('INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,\'completed\')',[input.tenantId,id,input.alias,model,inputTokens,outputTokens,costUsd]);
        await client.query('DELETE FROM core.model_budget_reservations WHERE tenant_id=$1 AND request_id=$2',[input.tenantId,id]);
      });
      return {text,requestId:id,model,inputTokens,outputTokens,costUsd};
    }catch(error){
      const code=error instanceof ModelGatewayError?error.code:'model_provider_request_failed';
      await withTenant(this.pool,input.tenantId,async(client)=>{
        await client.query('INSERT INTO core.model_usage(tenant_id,request_id,model_alias,model_name,input_tokens,output_tokens,cost_usd,outcome,safe_error_code) VALUES($1,$2,$3,$4,0,0,0,\'failed\',$5)',[input.tenantId,id,input.alias,model,code]);
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

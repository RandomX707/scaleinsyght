import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { OpenAIModelGateway } from '@scaleinsyght/model-gateway';
import type { QueryIntent } from '@scaleinsyght/contracts';
import { selectSources,type CandidateSource } from './source-selection.js';
import { decodePlannerOutput,describePlan,normalizeCatalogMentions,plannerSchema,verificationSchema } from './structured-planner.js';

export type PlanningSource = {source_id:string;agent_id:string;group_id:string;group_version:number;display_name:string;connector_type:string};

export async function planLiveQuestion(pool:Pool, tenantId:string, question:string, candidates:PlanningSource[], priorTurns:Array<{role:'user'|'assistant';content:string}>, principalId?:string) {
  let selected=candidates;
  let intents:QueryIntent[]|undefined;
  let plannerProvenance:{model:string;inputTokens:number;outputTokens:number}|undefined;
  const catalogue=await withTenant(pool,tenantId,client=>client.query<{source_id:string;assets:Array<{qualified_name:string;columns:Array<{name:string;label?:string;data_type:string;sensitivity_tags:string[]}>}>}>(`SELECT c.connection_id AS source_id,coalesce(jsonb_agg(jsonb_build_object('qualified_name',d.qualified_name,'columns',coalesce(fields.columns,'[]'::jsonb)) ORDER BY d.qualified_name) FILTER(WHERE d.asset_id IS NOT NULL),'[]'::jsonb) AS assets
    FROM registry.connections c LEFT JOIN graph.assets d ON d.tenant_id=c.tenant_id AND d.source_id=c.connection_id AND d.asset_type='dataset' AND d.active
    LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('name',substr(f.qualified_name,length(d.qualified_name)+2),'data_type',p.data_type,'label',p.display_name,'sensitivity_tags',p.sensitivity_tags) ORDER BY f.qualified_name) AS columns FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.to_asset_id LEFT JOIN LATERAL(SELECT data_type,sensitivity_tags,display_name FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true WHERE r.tenant_id=c.tenant_id AND r.from_asset_id=d.asset_id AND r.relationship_type='CONTAINS') fields ON true
    WHERE c.tenant_id=$1 AND c.connection_id=ANY($2::uuid[]) GROUP BY c.connection_id`,[tenantId,candidates.map(row=>row.source_id)]));
  const catalogById=new Map(catalogue.rows.map(row=>[row.source_id,row.assets]));
  const relationships=await withTenant(pool,tenantId,client=>client.query<{source_index:number;from_name:string;to_name:string;evidence_method:string;confidence_score:number}>(`SELECT array_position($2::uuid[],sourceField.source_id)::integer-1 AS source_index,sourceField.qualified_name AS from_name,targetField.qualified_name AS to_name,a.evidence_method,a.confidence_score FROM graph.assets sourceField JOIN graph.relationships r ON r.tenant_id=sourceField.tenant_id AND r.from_asset_id=sourceField.asset_id AND r.relationship_type='REFERENCES' JOIN graph.assets targetField ON targetField.tenant_id=r.tenant_id AND targetField.asset_id=r.to_asset_id JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id WHERE r.tenant_id=$1 AND sourceField.source_id=ANY($2::uuid[]) AND targetField.source_id=sourceField.source_id AND (a.evidence_method='declared' OR (a.evidence_method='inferred' AND a.confidence_score>0.90)) ORDER BY 1,2,3`,[tenantId,candidates.map(row=>row.source_id)]));
  const glossary=await withTenant(pool,tenantId,client=>client.query<{term:string;description:string}>(`SELECT array_position($2::uuid[],source_id)::text||'.'||table_name||'.'||column_name AS term,left(description,400) AS description
    FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY term LIMIT 60`,[tenantId,candidates.map(row=>row.source_id)]));
  const metadata={classification:'METADATA_DESCRIPTIVE' as const,structural:{sources:candidates.map((row,index)=>({index,name:row.display_name||row.connector_type,type:row.connector_type,assets:catalogById.get(row.source_id)??[]})),relationships:relationships.rows},descriptive:Object.fromEntries(glossary.rows.map(row=>[row.term,row.description])),statistical:{},sensitivityTags:[]};
  const catalog=metadata.structural.sources;
  const schema=plannerSchema(catalog,relationships.rows);
  const normalize = (text:string) => normalizeCatalogMentions(text,catalog,catalog.flatMap(source=>[source.name,...(source.type==='sql_server'?['SQL Server']:[])]));
  const prompt=`Plan the exact question using the catalog and the typed response schema. First fill the declaration: what the question counts or measures (subject), the dimension it is broken down by (grouping, or null for a single value), each condition, whether it asks for values from two or more sources (comparison), and whether the catalog has a table for the subject (answerable). If it is not answerable, return an empty intents array; a loosely related object is insufficient. Then plan each source step and fill its declared fields to match: subject_table, measure, measure_column, grouping_column (null unless the answer is broken down) and filter_columns. Use the source and subject from earlier turns only when resolving a follow-up. Count records for quantities, order totals, volume or "how many". Sum a numeric column only for a requested amount. Use the exact display header to resolve workbook columns. For a date range use gte and upperExclusive with the next calendar boundary. Ranked groups use value sort and a limit. For join operations select a catalog join and its left table. Use null for unused fields.
Question: ${normalize(question)}
Prior turns: ${priorTurns.map(turn=>`${turn.role}: ${normalize(turn.content)}`).join('\n').slice(-900)}`;
  const attempts:Array<{model:string;inputTokens:number;outputTokens:number;purpose?:'plan'|'verify';error?:string}>=[];
  const gateway=new OpenAIModelGateway(pool);
  const call=(purpose:'plan'|'verify',text:string,responseSchema:Record<string,unknown>,maxOutputTokens:number)=>gateway.complete({
    tenantId,...(principalId?{principalId}:{}),alias:'planning',purpose,question:text,metadata,responseSchema,maxOutputTokens,
  });
  let repair='';let verificationRejected=false;
  for(let attempt=0;attempt<3;attempt++){
    const completion=await call('plan',prompt+repair,schema,1800);
    const provenance={model:completion.model,inputTokens:completion.inputTokens,outputTokens:completion.outputTokens};
    attempts.push({...provenance,purpose:'plan'});
    let decoded;
    try {
      decoded=decodePlannerOutput(completion.text,catalog,relationships.rows);
    } catch(error) {
      const reason=error instanceof SyntaxError?'invalid_json':error instanceof Error?error.message:'invalid_intent';
      attempts.at(-1)!.error=reason;
      repair='\nPrevious response failed validation: '+reason;
      continue;
    }
    if(!decoded.steps.length){verificationRejected=false;break;}
    // A second, small call checks that the accepted plan answers the question (decision 44).
    const plan=describePlan(decoded.steps,catalog);
    const verdict=await call('verify',`Question: ${normalize(question)}
Prior turns: ${priorTurns.map(turn=>`${turn.role}: ${normalize(turn.content)}`).join('\n').slice(-900)}
Plan: ${plan}
Does this plan answer this question? A plan over a loosely related object, a single total where a breakdown is asked for, or a missing condition does not. Counting the rows of a table counts its distinct records.`,verificationSchema,800);
    attempts.push({model:verdict.model,inputTokens:verdict.inputTokens,outputTokens:verdict.outputTokens,purpose:'verify'});
    let answers=false;let reason='no reason given';
    try{const parsed=JSON.parse(verdict.text) as {answers_question?:unknown;reason?:unknown};answers=parsed.answers_question===true;if(typeof parsed.reason==='string')reason=parsed.reason.slice(0,300);}catch{reason='invalid verification response';}
    if(answers){
      selected=decoded.steps.map(item=>candidates[item.index]!);
      intents=decoded.steps.map(item=>item.intent);
      plannerProvenance=provenance;
      break;
    }
    verificationRejected=true;
    attempts.at(-1)!.error='verification_failed: '+reason.slice(0,200);
    repair=`\nThe previous plan was checked and does not answer the question: ${reason} Previous plan: ${plan}`;
  }
  if(!intents)return {kind:'rejected' as const,reason:verificationRejected||!attempts.at(-1)?.error?'analytic_query_unsupported':'analytic_query_intent_invalid',attempts};
  const candidateSources:CandidateSource[]=candidates.map(row=>({sourceId:row.source_id,name:row.display_name||row.connector_type,connectorType:row.connector_type,tables:new Map((catalogById.get(row.source_id)??[]).map(asset=>[(asset.qualified_name.split('.').at(-1)??asset.qualified_name).toLowerCase(),new Set(asset.columns.map(column=>column.name.toLowerCase()))]))}));
  const choice=selectSources({question,context:priorTurns.map(turn=>turn.content).join('\n'),candidates:candidateSources,selected:selected.map(row=>candidateSources.find(source=>source.sourceId===row.source_id)!),intents:intents as unknown as Array<Record<string,unknown>>});
  if(choice.kind==='ask')return {kind:'choice' as const,options:choice.options,attempts};
  return {kind:'planned' as const,selected,intents,provenance:{...plannerProvenance!,typedPlan:{attempts,intents:intents.map((intent,index)=>({source_index:candidates.indexOf(selected[index]!),source_name:selected[index]!.display_name,intent})),source_selection:{used:choice.used,unused:choice.unused}}}};
}

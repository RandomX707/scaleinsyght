import { createHash, createHmac, randomUUID } from 'node:crypto';
import { GraphEventSchema, LineagePathSchema, type GraphAssertion, type GraphEvent, type LineagePath } from '@scaleinsyght/contracts';
import { withTenant, type Pool, type PoolClient } from '@scaleinsyght/db';
import { getGoldenMetadataFixture, getGoldenPhase3Dataset } from '@scaleinsyght/connectors';

export type ReviewStatus = GraphAssertion['review_status'];

export function reviewAssertion<T extends GraphAssertion>(assertion: T, status: ReviewStatus): T {
  return { ...assertion, review_status: status };
}

export function invalidateAssertionForTransformationChange<T extends GraphAssertion>(assertion: T): T {
  return { ...assertion, review_status: 'stale', verification: 'unverified' };
}

export interface IdPathStep {
  assetId: string;
  change: 'none' | 'renamed' | 'cast' | 'derived' | 'unknown';
  confidence: number;
  assertionId: string | null;
}

export interface IdPath {
  steps: IdPathStep[];
  gapIds: string[];
  confidence: number;
  complete: boolean;
}

export function buildIdPath(steps: IdPathStep[], gapIds: string[]): IdPath {
  const confidence = steps.length === 0 ? 0 : Math.min(...steps.map((step) => step.confidence));
  return { steps: [...steps], gapIds: [...gapIds], confidence, complete: gapIds.length === 0 };
}

/** Returns a tenant-scoped keyed fingerprint. Raw identifiers must never be stored or logged. */
export function fingerprintIdentifier(masterKey: Uint8Array, tenantId: string, value: string): string {
  if (masterKey.byteLength < 32 || tenantId.length === 0 || value.length === 0) {
    throw new Error('invalid_identifier_input');
  }
  const tenantKey = createHmac('sha256', masterKey)
    .update('scale-insyght:id-fingerprint:v1\0', 'utf8')
    .update(tenantId, 'utf8')
    .digest();
  return createHmac('sha256', tenantKey).update(value, 'utf8').digest('hex');
}

export async function writeGraphEvent(client: PoolClient, event: GraphEvent): Promise<void> {
  const safe = GraphEventSchema.parse(event);
  await client.query(
    `INSERT INTO graph.events(tenant_id,event_type,asset_id,assertion_id,report_asset_id,safe_payload)
     VALUES(current_setting('app.tenant_id'),$1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
    [safe.event_type,safe.asset_id ?? null,safe.assertion_id ?? null,safe.report_asset_id ?? null,JSON.stringify(safe.safe_payload)],
  );
}

export interface QueryLineageInput {
  tenantId: string;
  assetId: string;
  direction: 'upstream' | 'downstream' | 'both';
  maxDepth?: number;
  asOf?: Date;
  methods?: GraphAssertion['evidence_method'][];
}

export async function queryLineage(pool: Pool, input: QueryLineageInput): Promise<LineagePath> {
  const maxDepth=input.maxDepth??20;
  if(!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>20)throw new Error('invalid_lineage_depth');
  return withTenant(pool, input.tenantId, async (client) => {
    type LineageEdge={from_asset_id:string;to_asset_id:string;relationship_id:string;granularity:'system'|'dataset'|'field'|'metric'|'report'};
    const edgeById=new Map<string,LineageEdge>();
    const visitedSet=new Set<string>([input.assetId]);
    let frontier=[input.assetId];
    for(let depth=0;depth<maxDepth&&frontier.length>0;depth++){
      const level=await client.query<LineageEdge>(
        `SELECT r.from_asset_id,r.to_asset_id,r.relationship_id,r.granularity FROM graph.relationships r
         WHERE $3 IN ('downstream','both') AND r.tenant_id=$1 AND r.family='data_flow' AND r.from_asset_id=ANY($2::uuid[])
           AND EXISTS(SELECT 1 FROM graph.assertions a WHERE a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
             AND ($4::timestamptz IS NULL OR (a.captured_at<=$4 AND (a.valid_from IS NULL OR a.valid_from<=$4) AND (a.valid_to IS NULL OR a.valid_to>=$4)))
             AND ($5::text[] IS NULL OR a.evidence_method=ANY($5::text[])))
         UNION
         SELECT r.from_asset_id,r.to_asset_id,r.relationship_id,r.granularity FROM graph.relationships r
         WHERE $3 IN ('upstream','both') AND r.tenant_id=$1 AND r.family='data_flow' AND r.to_asset_id=ANY($2::uuid[])
           AND EXISTS(SELECT 1 FROM graph.assertions a WHERE a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
             AND ($4::timestamptz IS NULL OR (a.captured_at<=$4 AND (a.valid_from IS NULL OR a.valid_from<=$4) AND (a.valid_to IS NULL OR a.valid_to>=$4)))
             AND ($5::text[] IS NULL OR a.evidence_method=ANY($5::text[])))`,
        [input.tenantId,frontier,input.direction,input.asOf??null,input.methods??null]);
      const next=new Set<string>();
      for(const edge of level.rows){
        edgeById.set(edge.relationship_id,edge);
        if(input.direction!=='upstream'&&!visitedSet.has(edge.to_asset_id))next.add(edge.to_asset_id);
        if(input.direction!=='downstream'&&!visitedSet.has(edge.from_asset_id))next.add(edge.from_asset_id);
      }
      for(const assetId of next)visitedSet.add(assetId);
      frontier=[...next];
    }
    const edgeRows=[...edgeById.values()];
    const visited=[...visitedSet];
    const assets=await client.query<{asset_id:string;qualified_name:string;asset_type:string;active:boolean}>(
      'SELECT asset_id,qualified_name,asset_type,active FROM graph.assets WHERE tenant_id=$1 AND asset_id=ANY($2::uuid[])',[input.tenantId,visited]);
    const assertionRows = await client.query<{ assertion_id:string; relationship_id:string; evidence_method:GraphAssertion['evidence_method']; review_status:GraphAssertion['review_status']; verification:GraphAssertion['verification']; evidence_ids:string[]; confidence_score:number|null; explanation:string|null; transformation:Record<string,unknown>|null; collector_version:string; captured_at:Date; valid_from:Date|null; valid_to:Date|null }>(
      `SELECT a.assertion_id,a.relationship_id,a.evidence_method,a.review_status,a.verification,a.evidence_ids,a.confidence_score,
         a.explanation,a.transformation,a.collector_version,a.captured_at,a.valid_from,a.valid_to
       FROM graph.assertions a WHERE a.tenant_id=$1 AND a.relationship_id=ANY($2::uuid[])
       AND ($3::timestamptz IS NULL OR (a.captured_at <= $3 AND (a.valid_from IS NULL OR a.valid_from <= $3) AND (a.valid_to IS NULL OR a.valid_to >= $3)))
       AND ($4::text[] IS NULL OR a.evidence_method=ANY($4::text[]))`,
      [input.tenantId,edgeRows.map((row) => row.relationship_id),input.asOf ?? null,input.methods ?? null],
    );
    const assertions = assertionRows.rows.map((row) => ({ ...row, confidence_score:row.confidence_score===null?null:Number(row.confidence_score),captured_at:row.captured_at.toISOString(),valid_from:row.valid_from?.toISOString() ?? null,valid_to:row.valid_to?.toISOString() ?? null }));
    const evidenceIds = [...new Set(assertions.flatMap((row) => row.evidence_ids))];
    const evidenceRows = evidenceIds.length ? await client.query<{ evidence_id:string;evidence_type:string;safe_metadata:Record<string,unknown>;captured_at:Date }>(
      'SELECT evidence_id,evidence_type,safe_metadata,captured_at FROM graph.evidence WHERE tenant_id=$1 AND evidence_id=ANY($2::uuid[])',[input.tenantId,evidenceIds]) : { rows:[] };
    const gaps = await client.query<{ gap_id:string;between_asset_ids:string[];reason:string;detected_at:Date;closed_by_assertion_id:string|null }>(
      'SELECT gap_id,between_asset_ids,reason,detected_at,closed_by_assertion_id FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids && $2::uuid[]',[input.tenantId,visited]);
    const result = {
      asset_ids:visited,
      assets:assets.rows,
      edges:edgeRows,
      assertions,
      evidence:evidenceRows.rows.map((row) => ({ ...row,captured_at:row.captured_at.toISOString() })),
      gaps:gaps.rows.map((row) => ({ ...row,detected_at:row.detected_at.toISOString() })),
      coverage:edgeRows.length === 0 ? 0 : Math.max(0, 1 - gaps.rows.length / edgeRows.length),
      observable:input.asOf === undefined || assertions.length > 0,
    };
    return LineagePathSchema.parse(result);
  });
}

export interface ImportGoldenMetadataInput {
  tenantId: string;
  principalId: string;
  connectionId: string;
  fixtureKey: string;
}

const idPathAssetNames=['SyntheticSQL.Customer.customer_id','SyntheticSnowflake.DIM_CUSTOMER.customer_key','dbt.customer_mart.customer_key'];

async function ensureGraphEvidence(client:PoolClient,input:{tenantId:string;evidenceType:string;safeMetadata:Record<string,unknown>}):Promise<string>{
  const metadata=JSON.stringify(input.safeMetadata);
  const inserted=await client.query<{evidence_id:string}>(
    `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(tenant_id,evidence_type,safe_metadata) WHERE safe_metadata ? 'fixture_key' DO NOTHING RETURNING evidence_id`,
    [input.tenantId,input.evidenceType,metadata]);
  if(inserted.rows[0])return inserted.rows[0].evidence_id;
  const existing=await client.query<{evidence_id:string}>(
    'SELECT evidence_id FROM graph.evidence WHERE tenant_id=$1 AND evidence_type=$2 AND safe_metadata=$3::jsonb ORDER BY captured_at,evidence_id LIMIT 1',
    [input.tenantId,input.evidenceType,metadata]);
  return existing.rows[0]!.evidence_id;
}

async function ensureGraphAssertion(client:PoolClient,input:{tenantId:string;relationshipId:string;evidenceMethod:GraphAssertion['evidence_method'];evidenceId:string;confidence:number;explanation:string|null;reviewStatus:GraphAssertion['review_status']}):Promise<string>{
  const existing=await client.query<{assertion_id:string;evidence_ids:string[]}>(
    `SELECT assertion_id,evidence_ids FROM graph.assertions
     WHERE tenant_id=$1 AND relationship_id=$2 AND evidence_method=$3 AND collector_version='phase3-golden-v1'
     ORDER BY captured_at,assertion_id LIMIT 1`,[input.tenantId,input.relationshipId,input.evidenceMethod]);
  if(existing.rows[0]){
    if(!existing.rows[0].evidence_ids.includes(input.evidenceId))await client.query(
      'UPDATE graph.assertions SET evidence_ids=array_append(evidence_ids,$3::uuid) WHERE tenant_id=$1 AND assertion_id=$2',
      [input.tenantId,existing.rows[0].assertion_id,input.evidenceId]);
    return existing.rows[0].assertion_id;
  }
  const inserted=await client.query<{assertion_id:string}>(
    `INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version,review_status)
     VALUES($1,$2,$3,ARRAY[$4::uuid],$5,$6,'phase3-golden-v1',$7)
     ON CONFLICT(tenant_id,relationship_id,evidence_method,collector_version) WHERE collector_version='phase3-golden-v1' DO NOTHING RETURNING assertion_id`,
    [input.tenantId,input.relationshipId,input.evidenceMethod,input.evidenceId,input.confidence,input.explanation,input.reviewStatus]);
  if(inserted.rows[0])return inserted.rows[0].assertion_id;
  const conflicted=await client.query<{assertion_id:string;evidence_ids:string[]}>(
    `SELECT assertion_id,evidence_ids FROM graph.assertions WHERE tenant_id=$1 AND relationship_id=$2
     AND evidence_method=$3 AND collector_version='phase3-golden-v1' ORDER BY captured_at,assertion_id LIMIT 1`,
    [input.tenantId,input.relationshipId,input.evidenceMethod]);
  const existingAssertion=conflicted.rows[0]!;
  if(!existingAssertion.evidence_ids.includes(input.evidenceId))await client.query(
    'UPDATE graph.assertions SET evidence_ids=array_append(evidence_ids,$3::uuid) WHERE tenant_id=$1 AND assertion_id=$2',
    [input.tenantId,existingAssertion.assertion_id,input.evidenceId]);
  return existingAssertion.assertion_id;
}

export async function importGoldenMetadata(pool: Pool, input: ImportGoldenMetadataInput): Promise<{ assets: number; flows: number; reports: number; gaps: number }> {
  const fixture=getGoldenMetadataFixture(input.fixtureKey);
  const expectedSource={dbt:'golden-dbt',tableau:'golden-tableau',power_bi:'golden-powerbi'}[fixture.tool];
  return withTenant(pool,input.tenantId,async(client)=>{
    const connection=await client.query<{source_ref:string|null;connector_type:string;status:string}>(
      'SELECT source_ref,connector_type,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[input.tenantId,input.connectionId]);
    const row=connection.rows[0];
    if(!row||row.status!=='active'||row.connector_type!==fixture.tool||row.source_ref!==expectedSource)throw new Error('metadata_connection_not_found');
    const corpus=getGoldenPhase3Dataset();
    const assetIds=new Map<string,string>();
    for(const asset of fixture.assets){
      const kind=asset.kind==='report'?'report':asset.kind==='metric'?'metric':asset.kind==='field'?'field':'dataset';
      const fingerprint=createHash('sha256').update(`${input.tenantId}\0${asset.name}`).digest();
      const inserted=await client.query<{asset_id:string}>(
        `INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp()
         RETURNING asset_id`,[input.tenantId,input.connectionId,kind,asset.name,fingerprint]);
      assetIds.set(asset.name,inserted.rows[0]!.asset_id);
    }
    const referencedNames=[...new Set([
      ...fixture.flows.flatMap((flow)=>[flow.from,flow.to]),
      fixture.disputed.from,fixture.disputed.to,
      ...corpus.gaps.flatMap((gap)=>gap.between),
      ...corpus.assets.filter((asset)=>asset.kind==='field'&&/\.(customer_id|customer_key)$/.test(asset.name)).map((asset)=>asset.name),
      ...idPathAssetNames,
      corpus.reportImpact.changedAsset,corpus.reportImpact.report,
    ])];
    const referenced=await client.query<{asset_id:string;qualified_name:string}>(
      'SELECT asset_id,qualified_name FROM graph.assets WHERE tenant_id=$1 AND active AND qualified_name=ANY($2::text[]) ORDER BY qualified_name,first_seen_at,asset_id',
      [input.tenantId,referencedNames]);
    for(const asset of referenced.rows)if(!assetIds.has(asset.qualified_name))assetIds.set(asset.qualified_name,asset.asset_id);
    for(const report of fixture.reports){
      const reportId=assetIds.get(report.name);
      if(reportId)await ensureGraphEvidence(client,{tenantId:input.tenantId,evidenceType:'report_link',safeMetadata:{asset_id:reportId,tool:report.tool,safe_path:report.safe_path,fixture_key:input.fixtureKey}});
    }
    let flowCount=0;
    const assertionFor=new Map<string,string>();
    for(const flow of fixture.flows){
      const fromId=assetIds.get(flow.from),toId=assetIds.get(flow.to);
      if(!fromId||!toId)continue;
      const granularity=flow.grain==='field'?'field':flow.grain==='metric'?'metric':flow.grain==='report'?'report':'dataset';
      const relation=await client.query<{relationship_id:string}>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         VALUES($1,'data_flow','DERIVES_FROM',$2,$3,$4) ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,
        [input.tenantId,fromId,toId,granularity]);
      const evidenceId=await ensureGraphEvidence(client,{tenantId:input.tenantId,evidenceType:flow.method==='parsed'?'sql_parse':'manifest',safeMetadata:{fixture_key:input.fixtureKey,tool:fixture.tool,grain:flow.grain}});
      const assertionId=await ensureGraphAssertion(client,{tenantId:input.tenantId,relationshipId:relation.rows[0]!.relationship_id,evidenceMethod:flow.method,evidenceId,confidence:flow.confidence,explanation:flow.change==='renamed'?'Identifier renamed across synthetic systems':null,reviewStatus:'unreviewed'});
      assertionFor.set(`${flow.from}\0${flow.to}`,assertionId);
      flowCount++;
    }
    const dispute=fixture.disputed;
    const disputedFrom=assetIds.get(dispute.from),disputedTo=assetIds.get(dispute.to);
    if(fixture.tool==='dbt'&&disputedFrom&&disputedTo){
      const relationship=await client.query<{relationship_id:string}>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         VALUES($1,'data_flow','MAPS_TO',$2,$3,'field') ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,[input.tenantId,disputedFrom,disputedTo]);
      const evidenceIds:string[]=[];
      for(const source of dispute.evidence)evidenceIds.push(await ensureGraphEvidence(client,{tenantId:input.tenantId,evidenceType:'manifest',safeMetadata:{fixture_key:input.fixtureKey,source}}));
      let assertionId='';
      for(const evidenceId of evidenceIds)assertionId=await ensureGraphAssertion(client,{tenantId:input.tenantId,relationshipId:relationship.rows[0]!.relationship_id,evidenceMethod:'inferred',evidenceId,confidence:0.62,explanation:'Conflicting synthetic mapping evidence',reviewStatus:'disputed'});
      assertionFor.set(`${dispute.from}\0${dispute.to}`,assertionId);
    }
    let gapCount=0;
    const gapIds=new Map<string,string>();
    for(const gap of corpus.gaps){
      const ids=gap.between.map((name)=>assetIds.get(name)).filter((id):id is string=>Boolean(id));
      if(ids.length!==gap.between.length)continue;
      const newGap=await client.query<{gap_id:string}>('INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,$2::uuid[],$3) ON CONFLICT(tenant_id,between_asset_ids,reason) DO NOTHING RETURNING gap_id',[input.tenantId,ids,gap.reason]);
      const existing=newGap.rows[0]??(await client.query<{gap_id:string}>('SELECT gap_id FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids=$2::uuid[] AND reason=$3 ORDER BY detected_at,gap_id LIMIT 1',[input.tenantId,ids,gap.reason])).rows[0]!;
      gapIds.set(gap.between.join('\0'),existing.gap_id);gapCount++;
    }
    for(const asset of corpus.assets.filter((candidate)=>candidate.kind==='field'&&/\.(customer_id|customer_key)$/.test(candidate.name))){
      const fieldName=asset.name.split('.').at(-1)!;
      const assetId=asset&&assetIds.get(asset.name);
      if(assetId)await client.query(`INSERT INTO graph.id_fields(tenant_id,asset_id,field_name,entity_hint,format_pattern,detection,confidence)
        VALUES($1,$2,$3,'customer','opaque_customer_key','inferred',0.900) ON CONFLICT(tenant_id,asset_id,field_name) DO UPDATE SET active=true`,[input.tenantId,assetId,fieldName]);
    }
    const fieldAssetIds=idPathAssetNames.map((name)=>assetIds.get(name));
    const missingGap=corpus.gaps.find((gap)=>gap.between.includes(idPathAssetNames.at(-1)!));
    const missingGapId=missingGap?gapIds.get(missingGap.between.join('\0'))??null:null;
    if(fieldAssetIds.every((assetId):assetId is string=>Boolean(assetId))){
      const existingPath=await client.query<{path_id:string}>('SELECT path_id FROM graph.id_path_steps WHERE tenant_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY sequence LIMIT 1',[input.tenantId,fieldAssetIds]);
      const idPathId=existingPath.rows[0]?.path_id??randomUUID();
      for(const [index,name] of idPathAssetNames.entries()){
        const assetId=fieldAssetIds[index]!;
        const assertionId=index<idPathAssetNames.length-1?assertionFor.get(`${name}\0${idPathAssetNames[index+1]}`):assertionFor.get(`${idPathAssetNames[index-1]}\0${name}`);
        await client.query(`INSERT INTO graph.id_path_steps(tenant_id,path_id,sequence,asset_id,assertion_id,change_type,confidence,gap_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,path_id,sequence) DO UPDATE SET asset_id=EXCLUDED.asset_id,assertion_id=EXCLUDED.assertion_id,change_type=EXCLUDED.change_type,confidence=EXCLUDED.confidence,gap_id=EXCLUDED.gap_id`,
          [input.tenantId,idPathId,index+1,assetId,assertionId??null,index===1?'renamed':'none',index===0?0.94:0.62,index===idPathAssetNames.length-1?missingGapId:null]);
      }
    }
    const impactedAssetId=assetIds.get(corpus.reportImpact.changedAsset);
    const reportAssetId=assetIds.get(corpus.reportImpact.report);
    if(impactedAssetId&&reportAssetId){
      await client.query("SELECT set_config('app.principal_id',$1,true)",[input.principalId]);
      await client.query(`INSERT INTO core.notifications(tenant_id,user_id,notification_type,safe_summary,report_asset_id)
        VALUES($1,$2,'report_impact',$3::jsonb,$4) ON CONFLICT(tenant_id,user_id,report_asset_id,notification_type) WHERE notification_type='report_impact' DO NOTHING`,
        [input.tenantId,input.principalId,JSON.stringify({report_name:corpus.reportImpact.report,changed_asset:corpus.reportImpact.changedAsset,reason_code:'synthetic_lineage_change'}),reportAssetId]);
      const existingImpact=await client.query<{event_id:string}>(
        "SELECT event_id FROM graph.events WHERE tenant_id=$1 AND event_type='report_impacted' AND asset_id=$2 AND report_asset_id=$3 LIMIT 1",
        [input.tenantId,impactedAssetId,reportAssetId]);
      if(!existingImpact.rowCount)await writeGraphEvent(client,{event_type:'report_impacted',asset_id:impactedAssetId,report_asset_id:reportAssetId,safe_payload:{report_count:1,reason_code:'synthetic_lineage_change'}});
    }
    const priorImport=await client.query<{event_id:string}>(
      "SELECT event_id FROM graph.events WHERE tenant_id=$1 AND event_type='metadata_imported' AND safe_payload->>'fixture_key'=$2 LIMIT 1",
      [input.tenantId,input.fixtureKey]);
    if(!priorImport.rowCount){
      const event:GraphEvent={event_type:'metadata_imported',safe_payload:{fixture_key:input.fixtureKey,asset_count:fixture.assets.length,tool:fixture.tool}};
      await writeGraphEvent(client,event);
      const cursor=await client.query<{event_cursor:string}>("SELECT coalesce(max(event_id),0)::text event_cursor FROM graph.events WHERE tenant_id=$1",[input.tenantId]);
      const count=await client.query<{asset_count:number}>("SELECT count(*)::int asset_count FROM graph.assets WHERE tenant_id=$1",[input.tenantId]);
      await client.query('INSERT INTO graph.snapshots(tenant_id,event_cursor,asset_count) VALUES($1,$2,$3) ON CONFLICT(tenant_id,event_cursor) DO NOTHING',[input.tenantId,cursor.rows[0]!.event_cursor,count.rows[0]!.asset_count]);
    }
    return {assets:fixture.assets.length,flows:flowCount,reports:fixture.reports.length,gaps:gapCount};
  });
}

export async function reviewGraphAssertion(pool:Pool,input:{tenantId:string;principalId:string;assertionId:string;status:'accepted'|'disputed'|'rejected'}):Promise<GraphAssertion>{
  return withTenant(pool,input.tenantId,async(client)=>{
    const result=await client.query<GraphAssertion>(
      `UPDATE graph.assertions SET review_status=$3,reviewer_id=$4,reviewed_at=clock_timestamp()
       WHERE tenant_id=$1 AND assertion_id=$2 RETURNING assertion_id,relationship_id,evidence_method,review_status,verification,evidence_ids,confidence_score,explanation,transformation,collector_version,captured_at,valid_from,valid_to`,
      [input.tenantId,input.assertionId,input.status,input.principalId]);
    if(!result.rowCount)throw new Error('assertion_not_found');
    await writeGraphEvent(client,{event_type:'assertion_reviewed',assertion_id:input.assertionId,safe_payload:{review_status:input.status}});
    return result.rows[0]!;
  });
}

export async function verifyAssertionFromRun(pool:Pool,input:{tenantId:string;assertionId:string;runId:string}):Promise<GraphAssertion>{
  return withTenant(pool,input.tenantId,async(client)=>{
    const assertion=await client.query<{from_asset_id:string;to_asset_id:string;granularity:string}>(
      `SELECT r.from_asset_id,r.to_asset_id,r.granularity FROM graph.assertions a
       JOIN graph.relationships r ON r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id
       WHERE a.tenant_id=$1 AND a.assertion_id=$2 AND r.family='data_flow'`,[input.tenantId,input.assertionId]);
    const edge=assertion.rows[0];if(!edge)throw new Error('assertion_not_found');
    const run=await client.query<{state:string}>(
      'SELECT state FROM runs.runs WHERE tenant_id=$1 AND run_id=$2',[input.tenantId,input.runId]);
    const completion=await client.query<{event_id:string}>(
      `SELECT event_id FROM runs.events WHERE tenant_id=$1 AND run_id=$2 AND event_type='lineage_observed'
       AND safe_payload->'lineage' @> $3::jsonb
       AND EXISTS(SELECT 1 FROM runs.events terminal WHERE terminal.tenant_id=$1 AND terminal.run_id=$2 AND terminal.event_type='run_terminal' AND terminal.safe_payload->>'state'='COMPLETED')
       ORDER BY sequence DESC LIMIT 1`,
      [input.tenantId,input.runId,JSON.stringify([{from_asset_id:edge.from_asset_id,to_asset_id:edge.to_asset_id,granularity:edge.granularity}])]);
    if(run.rows[0]?.state!=='COMPLETED'||!completion.rowCount)throw new Error('exact_successful_run_pair_not_found');
    const evidence=await client.query<{evidence_id:string}>(
      `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'run_event',$2::jsonb) RETURNING evidence_id`,
      [input.tenantId,JSON.stringify({run_id:input.runId,event_id:completion.rows[0]!.event_id})]);
    const updated=await client.query<GraphAssertion>(
      `UPDATE graph.assertions SET verification='run_verified',evidence_ids=array_append(evidence_ids,$3::uuid)
       WHERE tenant_id=$1 AND assertion_id=$2 RETURNING assertion_id,relationship_id,evidence_method,review_status,verification,evidence_ids,confidence_score,explanation,transformation,collector_version,captured_at,valid_from,valid_to`,
      [input.tenantId,input.assertionId,evidence.rows[0]!.evidence_id]);
    await writeGraphEvent(client,{event_type:'assertion_verification_changed',assertion_id:input.assertionId,safe_payload:{verification:'run_verified'}});
    return updated.rows[0]!;
  });
}

export async function reconcileAssertion(pool:Pool,input:{tenantId:string;assertionId:string;evidenceId:string}):Promise<GraphAssertion>{
  return withTenant(pool,input.tenantId,async(client)=>{
    const result=await client.query<GraphAssertion>(
      `UPDATE graph.assertions a SET verification='reconciled',evidence_ids=array_append(a.evidence_ids,$3::uuid)
       FROM graph.relationships r WHERE a.tenant_id=$1 AND a.assertion_id=$2 AND r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id AND r.family='data_flow' AND EXISTS(
         SELECT 1 FROM graph.evidence e WHERE e.tenant_id=a.tenant_id AND e.evidence_id=$3 AND e.evidence_type='reconciliation'
          AND e.safe_metadata @> jsonb_build_object('from_asset_id',r.from_asset_id,'to_asset_id',r.to_asset_id,'granularity',r.granularity))
       RETURNING a.assertion_id,a.relationship_id,a.evidence_method,a.review_status,a.verification,a.evidence_ids,a.confidence_score,a.explanation,a.transformation,a.collector_version,a.captured_at,a.valid_from,a.valid_to`,
      [input.tenantId,input.assertionId,input.evidenceId]);
    if(!result.rowCount)throw new Error('reconciliation_evidence_not_found');
    await writeGraphEvent(client,{event_type:'assertion_verification_changed',assertion_id:input.assertionId,safe_payload:{verification:'reconciled'}});
    return result.rows[0]!;
  });
}

export async function listIdentifierFields(pool:Pool,tenantId:string):Promise<Array<{asset_id:string;field_name:string;entity_hint:string|null;format_pattern:string;detection:'declared'|'inferred';confidence:number;assertion_id:string|null}>>{
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{asset_id:string;field_name:string;entity_hint:string|null;format_pattern:string;detection:'declared'|'inferred';confidence:number;assertion_id:string|null}>(
      `SELECT asset_id,field_name,entity_hint,format_pattern,detection,confidence,assertion_id FROM graph.id_fields WHERE tenant_id=$1 AND active ORDER BY field_name,asset_id`,[tenantId]);
    return result.rows.map((row)=>({...row,confidence:Number(row.confidence)}));
  });
}

export async function traceIdentifier(pool:Pool,input:{tenantId:string;assetId:string;value:string;masterKey:Uint8Array}):Promise<Array<{asset_id:string;field_name:string;entity_hint:string|null;format_pattern:string}>>{
  if(typeof input.value!=='string'||input.value.length<1||input.value.length>256)throw new Error('invalid_identifier_value');
  const fingerprint=Buffer.from(fingerprintIdentifier(input.masterKey,input.tenantId,input.value),'hex');
  return withTenant(pool,input.tenantId,async(client)=>{
    const result=await client.query<{asset_id:string;field_name:string;entity_hint:string|null;format_pattern:string}>(
      `SELECT f.asset_id,f.field_name,d.entity_hint,d.format_pattern FROM graph.id_fingerprints f
       JOIN graph.id_fields d ON d.tenant_id=f.tenant_id AND d.asset_id=f.asset_id AND d.field_name=f.field_name
       WHERE f.tenant_id=$1 AND f.fingerprint=$2 AND f.asset_id=$3 AND d.active`,[input.tenantId,fingerprint,input.assetId]);
    return result.rows;
  });
}

export async function getIdentifierPath(pool:Pool,input:{tenantId:string;assetId:string}):Promise<IdPath & {fields:Array<{assetId:string;fieldName:string}>}>{
  const stored=await withTenant(pool,input.tenantId,async(client)=>client.query<{asset_id:string;field_name:string|null;change_type:IdPathStep['change'];confidence:number;assertion_id:string|null;gap_id:string|null}>(
    `SELECT s.asset_id,d.field_name,s.change_type,s.confidence,s.assertion_id,s.gap_id FROM graph.id_path_steps s
     LEFT JOIN graph.id_fields d ON d.tenant_id=s.tenant_id AND d.asset_id=s.asset_id
     WHERE s.tenant_id=$1 AND s.path_id=(SELECT path_id FROM graph.id_path_steps WHERE tenant_id=$1 AND asset_id=$2 ORDER BY path_id LIMIT 1)
     ORDER BY s.sequence`,[input.tenantId,input.assetId]));
  if(stored.rows.length){
    const steps=stored.rows.map((row)=>({assetId:row.asset_id,change:row.change_type,confidence:Number(row.confidence),assertionId:row.assertion_id}));
    return {...buildIdPath(steps,stored.rows.flatMap((row)=>row.gap_id?[row.gap_id]:[])),fields:stored.rows.filter((row)=>row.field_name!==null).map((row)=>({assetId:row.asset_id,fieldName:row.field_name!}))};
  }
  const lineage=await queryLineage(pool,{tenantId:input.tenantId,assetId:input.assetId,direction:'both'});
  return withTenant(pool,input.tenantId,async(client)=>{
    const fields=await client.query<{asset_id:string;field_name:string}>(
      'SELECT asset_id,field_name FROM graph.id_fields WHERE tenant_id=$1 AND active AND asset_id=ANY($2::uuid[]) ORDER BY array_position($2::uuid[],asset_id)',[input.tenantId,lineage.asset_ids]);
    const confidence=lineage.assertions.map((assertion)=>assertion.confidence_score??0);
    const changeByAsset=new Map<string,IdPathStep['change']>();
    for(let index=1;index<fields.rows.length;index++)changeByAsset.set(fields.rows[index]!.asset_id,fields.rows[index]!.field_name===fields.rows[index-1]!.field_name?'none':'renamed');
    const steps:IdPathStep[]=fields.rows.map((field,index)=>({assetId:field.asset_id,change:index===0?'none':changeByAsset.get(field.asset_id)??'renamed',confidence:confidence.length?Math.min(...confidence):0,assertionId:lineage.assertions[index]?.assertion_id??null}));
    return {...buildIdPath(steps,lineage.gaps.map((gap)=>gap.gap_id)),fields:fields.rows.map((field)=>({assetId:field.asset_id,fieldName:field.field_name}))};
  });
}

export async function listGraphSnapshots(pool:Pool,tenantId:string):Promise<Array<{snapshot_id:string;captured_at:string;event_cursor:number;asset_count:number}>>{
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{snapshot_id:string;captured_at:Date;event_cursor:string;asset_count:number}>(
      'SELECT snapshot_id,captured_at,event_cursor,asset_count FROM graph.snapshots WHERE tenant_id=$1 ORDER BY captured_at,snapshot_id',[tenantId]);
    return result.rows.map((row)=>({...row,captured_at:row.captured_at.toISOString(),event_cursor:Number(row.event_cursor)}));
  });
}

export async function compareGraphSnapshots(pool:Pool,input:{tenantId:string;fromSnapshotId:string;toSnapshotId:string}):Promise<{from:string;to:string;changes:Array<{event_type:string;asset_id:string|null;report_asset_id:string|null;safe_payload:Record<string,unknown>}>}>{
  return withTenant(pool,input.tenantId,async(client)=>{
    const snapshots=await client.query<{snapshot_id:string;event_cursor:string}>(
      'SELECT snapshot_id,event_cursor FROM graph.snapshots WHERE tenant_id=$1 AND snapshot_id=ANY($2::uuid[])',[input.tenantId,[input.fromSnapshotId,input.toSnapshotId]]);
    const from=snapshots.rows.find((row)=>row.snapshot_id===input.fromSnapshotId),to=snapshots.rows.find((row)=>row.snapshot_id===input.toSnapshotId);
    if(!from||!to)throw new Error('snapshot_not_found');
    const changes=await client.query<{event_type:string;asset_id:string|null;report_asset_id:string|null;safe_payload:Record<string,unknown>}>(
      `SELECT event_type,asset_id,report_asset_id,safe_payload FROM graph.events WHERE tenant_id=$1 AND event_id>$2 AND event_id<=$3 ORDER BY event_id`,
      [input.tenantId,from.event_cursor,to.event_cursor]);
    return {from:from.snapshot_id,to:to.snapshot_id,changes:changes.rows};
  });
}

export async function getImpactRadius(pool:Pool,input:{tenantId:string;assetId:string}):Promise<{path:LineagePath;reports:Array<{asset_id:string;name:string;tool:string|null;safe_path:string|null}>}>{
  const path=await queryLineage(pool,{tenantId:input.tenantId,assetId:input.assetId,direction:'downstream'});
  const reports=await withTenant(pool,input.tenantId,async(client)=>client.query<{asset_id:string;name:string;tool:string|null;safe_path:string|null}>(
    `SELECT a.asset_id,a.qualified_name AS name,e.safe_metadata->>'tool' AS tool,e.safe_metadata->>'safe_path' AS safe_path
     FROM graph.assets a LEFT JOIN LATERAL (SELECT safe_metadata FROM graph.evidence WHERE tenant_id=a.tenant_id AND evidence_type='report_link'
       AND safe_metadata->>'asset_id'=a.asset_id::text ORDER BY captured_at DESC LIMIT 1) e ON true
     WHERE a.tenant_id=$1 AND a.asset_type='report' AND (a.asset_id=ANY($2::uuid[]) OR EXISTS(
       SELECT 1 FROM graph.events impact WHERE impact.tenant_id=$1 AND impact.event_type='report_impacted' AND impact.asset_id=$3 AND impact.report_asset_id=a.asset_id))
     ORDER BY a.qualified_name`,[input.tenantId,path.asset_ids,input.assetId]));
  return {path,reports:reports.rows};
}

export async function listReports(pool:Pool,tenantId:string):Promise<Array<{asset_id:string;name:string;tool:string|null;safe_path:string|null;lineage_assertions:number}>>{
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{asset_id:string;name:string;tool:string|null;safe_path:string|null;lineage_assertions:number}>(
      `SELECT a.asset_id,a.qualified_name AS name,e.safe_metadata->>'tool' AS tool,e.safe_metadata->>'safe_path' AS safe_path,
       (SELECT count(*)::int FROM graph.relationships r WHERE r.tenant_id=a.tenant_id AND r.to_asset_id=a.asset_id AND r.family='data_flow') AS lineage_assertions
       FROM graph.assets a LEFT JOIN LATERAL (SELECT safe_metadata FROM graph.evidence WHERE tenant_id=a.tenant_id AND evidence_type='report_link'
        AND safe_metadata->>'asset_id'=a.asset_id::text ORDER BY captured_at DESC LIMIT 1) e ON true
       WHERE a.tenant_id=$1 AND a.asset_type='report' AND a.active ORDER BY a.qualified_name`,[tenantId]);
    return result.rows;
  });
}

export async function listGraphAssertions(pool:Pool,tenantId:string):Promise<Array<{assertion_id:string;from_name:string;to_name:string;evidence_method:string;review_status:string;verification:string;confidence_score:number|null;evidence_count:number}>>{
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{assertion_id:string;from_name:string;to_name:string;evidence_method:string;review_status:string;verification:string;confidence_score:number|null;evidence_count:number}>(
      `SELECT a.assertion_id,f.qualified_name AS from_name,t.qualified_name AS to_name,a.evidence_method,a.review_status,a.verification,
       a.confidence_score,cardinality(a.evidence_ids)::int AS evidence_count
       FROM graph.assertions a JOIN graph.relationships r USING(tenant_id,relationship_id)
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id
       JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       WHERE a.tenant_id=$1 ORDER BY a.captured_at DESC,a.assertion_id`,[tenantId]);
    return result.rows.map((row)=>({...row,confidence_score:row.confidence_score===null?null:Number(row.confidence_score)}));
  });
}

export async function listGraphAssets(pool:Pool,tenantId:string):Promise<Array<{asset_id:string;qualified_name:string;asset_type:string;active:boolean}>>{
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{asset_id:string;qualified_name:string;asset_type:string;active:boolean}>(
      'SELECT asset_id,qualified_name,asset_type,active FROM graph.assets WHERE tenant_id=$1 ORDER BY qualified_name,asset_id',[tenantId]);
    return result.rows;
  });
}

import { createHash, createHmac } from 'node:crypto';
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
     VALUES(current_setting('app.tenant_id'),$1,$2,$3,$4,$5::jsonb)`,
    [safe.event_type,safe.asset_id ?? null,safe.assertion_id ?? null,safe.report_asset_id ?? null,JSON.stringify(safe.safe_payload)],
  );
}

export interface QueryLineageInput {
  tenantId: string;
  assetId: string;
  direction: 'upstream' | 'downstream' | 'both';
  asOf?: Date;
  methods?: GraphAssertion['evidence_method'][];
}

export async function queryLineage(pool: Pool, input: QueryLineageInput): Promise<LineagePath> {
  return withTenant(pool, input.tenantId, async (client) => {
    const edges = await client.query<{ from_asset_id: string; to_asset_id: string; relationship_id: string }>(
      `WITH RECURSIVE walk(asset_id,depth,visited) AS (
         SELECT $1::uuid,0,ARRAY[$1::uuid]
         UNION ALL
         SELECT CASE WHEN $2='upstream' THEN r.from_asset_id ELSE r.to_asset_id END,w.depth+1,
           w.visited || CASE WHEN $2='upstream' THEN r.from_asset_id ELSE r.to_asset_id END
         FROM walk w JOIN graph.relationships r ON r.tenant_id=$3 AND r.family='data_flow'
           AND ((($2 IN ('downstream','both')) AND r.from_asset_id=w.asset_id) OR (($2 IN ('upstream','both')) AND r.to_asset_id=w.asset_id))
         WHERE w.depth<20 AND NOT (CASE WHEN $2='upstream' THEN r.from_asset_id ELSE r.to_asset_id END=ANY(w.visited))
       )
       SELECT DISTINCT r.from_asset_id,r.to_asset_id,r.relationship_id FROM walk w
       JOIN graph.relationships r ON r.tenant_id=$3 AND r.family='data_flow'
         AND (r.from_asset_id=w.asset_id OR r.to_asset_id=w.asset_id)
       WHERE w.depth>0 OR r.from_asset_id=$1 OR r.to_asset_id=$1`,
      [input.assetId,input.direction,input.tenantId],
    );
    const visited = [...new Set([input.assetId,...edges.rows.flatMap((row) => [row.from_asset_id,row.to_asset_id])])];
    const assertionRows = await client.query<{ assertion_id:string; relationship_id:string; evidence_method:GraphAssertion['evidence_method']; review_status:GraphAssertion['review_status']; verification:GraphAssertion['verification']; evidence_ids:string[]; confidence_score:number|null; explanation:string|null; transformation:Record<string,unknown>|null; collector_version:string; captured_at:Date; valid_from:Date|null; valid_to:Date|null }>(
      `SELECT a.assertion_id,a.relationship_id,a.evidence_method,a.review_status,a.verification,a.evidence_ids,a.confidence_score,
         a.explanation,a.transformation,a.collector_version,a.captured_at,a.valid_from,a.valid_to
       FROM graph.assertions a WHERE a.tenant_id=$1 AND a.relationship_id=ANY($2::uuid[])
       AND ($3::timestamptz IS NULL OR (a.captured_at <= $3 AND (a.valid_from IS NULL OR a.valid_from <= $3) AND (a.valid_to IS NULL OR a.valid_to >= $3)))
       AND ($4::text[] IS NULL OR a.evidence_method=ANY($4::text[]))`,
      [input.tenantId,edges.rows.map((row) => row.relationship_id),input.asOf ?? null,input.methods ?? null],
    );
    const assertions = assertionRows.rows.map((row) => ({ ...row, captured_at:row.captured_at.toISOString(),valid_from:row.valid_from?.toISOString() ?? null,valid_to:row.valid_to?.toISOString() ?? null }));
    const evidenceIds = [...new Set(assertions.flatMap((row) => row.evidence_ids))];
    const evidenceRows = evidenceIds.length ? await client.query<{ evidence_id:string;evidence_type:string;safe_metadata:Record<string,unknown>;captured_at:Date }>(
      'SELECT evidence_id,evidence_type,safe_metadata,captured_at FROM graph.evidence WHERE tenant_id=$1 AND evidence_id=ANY($2::uuid[])',[input.tenantId,evidenceIds]) : { rows:[] };
    const gaps = await client.query<{ gap_id:string;between_asset_ids:string[];reason:string;detected_at:Date;closed_by_assertion_id:string|null }>(
      'SELECT gap_id,between_asset_ids,reason,detected_at,closed_by_assertion_id FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids && $2::uuid[]',[input.tenantId,visited]);
    const result = {
      asset_ids:visited,
      assertions,
      evidence:evidenceRows.rows.map((row) => ({ ...row,captured_at:row.captured_at.toISOString() })),
      gaps:gaps.rows.map((row) => ({ ...row,detected_at:row.detected_at.toISOString() })),
      coverage:edges.rows.length === 0 ? 0 : Math.max(0, 1 - gaps.rows.length / edges.rows.length),
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
    for(const asset of corpus.assets){
      const kind=asset.kind==='report'?'report':asset.kind==='metric'?'metric':asset.kind==='field'?'field':'dataset';
      const fingerprint=createHash('sha256').update(`${input.tenantId}\0${asset.name}`).digest();
      const inserted=await client.query<{asset_id:string}>(
        `INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp()
         RETURNING asset_id`,[input.tenantId,input.connectionId,kind,asset.name,fingerprint]);
      assetIds.set(asset.name,inserted.rows[0]!.asset_id);
    }
    let flowCount=0;
    const evidenceFor=new Map<string,string>();
    for(const flow of corpus.flows){
      const fromId=assetIds.get(flow.from),toId=assetIds.get(flow.to);
      if(!fromId||!toId)continue;
      const granularity=flow.grain==='field'?'field':flow.grain==='metric'?'metric':flow.grain==='report'?'report':'dataset';
      const relation=await client.query<{relationship_id:string}>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         VALUES($1,'data_flow','DERIVES_FROM',$2,$3,$4) ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,
        [input.tenantId,fromId,toId,granularity]);
      const evidence=await client.query<{evidence_id:string}>(
        `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,$2,$3::jsonb) RETURNING evidence_id`,
        [input.tenantId,flow.method==='parsed'?'sql_parse':'manifest',JSON.stringify({fixture_key:input.fixtureKey,tool:fixture.tool,grain:flow.grain})]);
      const assertion=await client.query(
        `INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version,review_status)
         VALUES($1,$2,$3,ARRAY[$4::uuid],$5,$6,'phase3-golden-v1','unreviewed')`,
        [input.tenantId,relation.rows[0]!.relationship_id,flow.method,evidence.rows[0]!.evidence_id,flow.confidence,flow.change==='renamed'?'Identifier renamed across synthetic systems':null]);
      evidenceFor.set(`${flow.from}\0${flow.to}`,evidence.rows[0]!.evidence_id);
      flowCount+=assertion.rowCount??0;
    }
    const dispute=corpus.disputed;
    const disputedFrom=assetIds.get(dispute.from),disputedTo=assetIds.get(dispute.to);
    if(disputedFrom&&disputedTo){
      const relationship=await client.query<{relationship_id:string}>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         VALUES($1,'data_flow','MAPS_TO',$2,$3,'field') ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,[input.tenantId,disputedFrom,disputedTo]);
      const evidenceIds=[];
      for(const label of dispute.evidence){const item=await client.query<{evidence_id:string}>(
        'INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,\'manifest\',$2::jsonb) RETURNING evidence_id',[input.tenantId,JSON.stringify({fixture_key:input.fixtureKey,source:label})]);evidenceIds.push(item.rows[0]!.evidence_id);}
      await client.query(`INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,review_status,evidence_ids,confidence_score,explanation,collector_version)
        VALUES($1,$2,'inferred','disputed',$3::uuid[],0.62,'Conflicting synthetic mapping evidence','phase3-golden-v1')`,[input.tenantId,relationship.rows[0]!.relationship_id,evidenceIds]);
    }
    let gapCount=0;
    for(const gap of corpus.gaps){
      const ids=gap.between.map((name)=>assetIds.get(name)).filter((id):id is string=>Boolean(id));
      if(ids.length<1)continue;
      await client.query('INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,$2::uuid[],$3)',[input.tenantId,ids,gap.reason]);gapCount++;
    }
    for(const fieldName of ['customer_id','customer_key']){
      const asset=corpus.assets.find((candidate)=>candidate.kind==='field'&&candidate.name.endsWith(`.${fieldName}`));
      const assetId=asset&&assetIds.get(asset.name);
      if(assetId)await client.query(`INSERT INTO graph.id_fields(tenant_id,asset_id,field_name,entity_hint,format_pattern,detection,confidence)
        VALUES($1,$2,$3,'customer','opaque_customer_key','inferred',0.900) ON CONFLICT(tenant_id,asset_id,field_name) DO UPDATE SET active=true`,[input.tenantId,assetId,fieldName]);
    }
    const event:GraphEvent={event_type:'metadata_imported',safe_payload:{fixture_key:input.fixtureKey,asset_count:assetIds.size,tool:fixture.tool}};
    await writeGraphEvent(client,event);
    return {assets:assetIds.size,flows:flowCount,reports:fixture.reports.length,gaps:gapCount};
  });
}

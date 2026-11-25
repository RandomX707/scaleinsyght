import { createHash, createHmac } from 'node:crypto';
import { GraphEventSchema, LineagePathSchema, type GraphAssertion, type GraphEvent, type LineagePath } from '@scaleinsyght/contracts';
import { withTenant, type Pool, type PoolClient } from '@scaleinsyght/db';

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

export async function importDbtManifest(pool:Pool,input:{tenantId:string;connectionId:string;sourceConnectionId:string;manifest:unknown}):Promise<{assets:number;flows:number}> {
  if(!input.manifest||typeof input.manifest!=='object')throw new Error('invalid_dbt_manifest');
  const manifest=input.manifest as {metadata?:{dbt_version?:unknown};nodes?:Record<string,Record<string,unknown>>;sources?:Record<string,Record<string,unknown>>};
  if(!manifest.nodes||typeof manifest.nodes!=='object'||!manifest.sources||typeof manifest.sources!=='object')throw new Error('invalid_dbt_manifest');
  const models=Object.entries(manifest.nodes).filter(([,node])=>node.resource_type==='model');
  const sources=Object.entries(manifest.sources);
  if(!models.length||models.length>10_000||sources.length>10_000)throw new Error('invalid_dbt_manifest');
  const safeShape={dbt_version:String(manifest.metadata?.dbt_version??'unknown'),models:models.map(([id,node])=>({id,name:String(node.name),dependsOn:Array.isArray((node.depends_on as {nodes?:unknown[]}|undefined)?.nodes)?(node.depends_on as {nodes:unknown[]}).nodes.map(String).sort():[]})).sort((a,b)=>a.id.localeCompare(b.id))};
  const manifestHash=createHash('sha256').update(JSON.stringify(safeShape)).digest('hex');
  return withTenant(pool,input.tenantId,async(client)=>{
    const connections=await client.query<{connection_id:string;connector_type:string;status:string;source_ref:string|null}>(
      'SELECT connection_id,connector_type,status,source_ref FROM registry.connections WHERE tenant_id=$1 AND connection_id=ANY($2::uuid[])',[input.tenantId,[input.connectionId,input.sourceConnectionId]]);
    const byId=new Map(connections.rows.map(row=>[row.connection_id,row]));const dbt=byId.get(input.connectionId);const postgres=byId.get(input.sourceConnectionId);
    if(!dbt||dbt.status!=='active'||dbt.connector_type!=='dbt'||dbt.source_ref!=='local-dbt-manifest'||!postgres||postgres.status!=='active'||postgres.connector_type!=='postgres'||postgres.source_ref!=='local-hospital')throw new Error('dbt_connection_not_found');
    const assetIds=new Map<string,string>();let assetCount=0;let flowCount=0;
    for(const [uniqueId,source] of sources){
      const schema=String(source.schema??'public');const identifier=String(source.identifier??source.name??'');if(!/^[A-Za-z0-9_]+$/.test(schema)||! /^[A-Za-z0-9_]+$/.test(identifier))continue;
      const found=await client.query<{asset_id:string}>('SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND asset_type=\'dataset\' AND active',[input.tenantId,input.sourceConnectionId,`${schema}.${identifier}`]);
      if(found.rows[0])assetIds.set(uniqueId,found.rows[0].asset_id);
    }
    for(const [uniqueId,node] of models){
      const name=String(node.name??'');if(!/^[A-Za-z0-9_]+$/.test(name))continue;
      const qualifiedName=`dbt.${name}`;const fingerprint=createHash('sha256').update(`${input.tenantId}\0${qualifiedName}`).digest();
      const asset=await client.query<{asset_id:string}>('INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,\'dataset\',$3,$4) ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp() RETURNING asset_id',[input.tenantId,input.connectionId,qualifiedName,fingerprint]);
      const assetId=asset.rows[0]!.asset_id;assetIds.set(uniqueId,assetId);assetCount++;
      const structural={resource_type:'model',materialized:String((node.config as {materialized?:unknown}|undefined)?.materialized??'unknown')};
      const latest=await client.query<{version:number}>('SELECT version FROM graph.asset_versions WHERE tenant_id=$1 AND asset_id=$2 ORDER BY version DESC LIMIT 1',[input.tenantId,assetId]);
      if(!latest.rowCount)await client.query('INSERT INTO graph.asset_versions(tenant_id,asset_id,version,structural_attributes,statistics) VALUES($1,$2,1,$3::jsonb,\'{}\'::jsonb)',[input.tenantId,assetId,JSON.stringify(structural)]);
    }
    for(const [uniqueId,node] of models){
      const modelId=assetIds.get(uniqueId);const dependencies=(node.depends_on as {nodes?:unknown[]}|undefined)?.nodes;
      if(!modelId||!Array.isArray(dependencies))continue;
      for(const dependency of dependencies){const upstreamId=assetIds.get(String(dependency));if(!upstreamId)continue;
        const relationship=await client.query<{relationship_id:string}>('INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,\'data_flow\',\'DERIVES_FROM\',$2,$3,\'dataset\') ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id',[input.tenantId,modelId,upstreamId]);
        const relationId=relationship.rows[0]!.relationship_id;
        let evidenceId=(await client.query<{evidence_id:string}>("SELECT evidence_id FROM graph.evidence WHERE tenant_id=$1 AND evidence_type='manifest' AND safe_metadata->>'manifest_hash'=$2 AND safe_metadata->>'relationship_id'=$3 LIMIT 1",[input.tenantId,manifestHash,relationId])).rows[0]?.evidence_id;
        if(!evidenceId)evidenceId=(await client.query<{evidence_id:string}>("INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'manifest',$2::jsonb) RETURNING evidence_id",[input.tenantId,JSON.stringify({manifest_hash:manifestHash,relationship_id:relationId,dbt_version:safeShape.dbt_version})])).rows[0]!.evidence_id;
        const assertion=await client.query('SELECT 1 FROM graph.assertions WHERE tenant_id=$1 AND relationship_id=$2 AND evidence_method=\'declared\' AND collector_version=\'phase5b-dbt-manifest-v1\'', [input.tenantId,relationId]);
        if(!assertion.rowCount)await client.query('INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version) VALUES($1,$2,\'declared\',ARRAY[$3::uuid],1,\'Dependency declared by local dbt manifest\',\'phase5b-dbt-manifest-v1\')',[input.tenantId,relationId,evidenceId]);
        flowCount++;
      }
    }
    return {assets:assetCount,flows:flowCount};
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
export * from './sql-lineage.js';
export * from './dbt-artifacts.js';
export * from './lineage-graph.js';
export * from './lineage-answer.js';

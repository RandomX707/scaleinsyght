import { createHmac } from 'node:crypto';
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

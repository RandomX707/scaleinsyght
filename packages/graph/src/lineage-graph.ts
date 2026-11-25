import { withTenant, type Pool } from '@scaleinsyght/db';

export type EvidenceMethod = 'declared' | 'parsed' | 'observed' | 'inferred';
export type LineageGraphEdge = {
  relationshipId: string; from: string; to: string; methods: EvidenceMethod[]; method: EvidenceMethod;
  reviewStatus: string; verification: string; evidenceCount: number; explanations: string[]; transformation: string | null; collectors: string[];
};
export type LineageGraph = {
  datasets: Array<{ assetId: string; name: string; sourceId: string; sourceName: string; connectorType: string; objectType: string | null }>;
  fields: Array<{ assetId: string; datasetId: string; name: string; dataType: string | null }>;
  tableEdges: LineageGraphEdge[]; columnEdges: LineageGraphEdge[];
  gaps: Array<{ gapId: string; assetId: string; reason: string }>;
};

/** The strongest evidence wins the colour; every method stays listed, and none is ever shown as stronger than it is. */
const ORDER: EvidenceMethod[] = ['declared', 'parsed', 'observed', 'inferred'];

/** Every current data-flow edge in the tenant, at table and column level, with its evidence, plus every open gap. */
export async function getLineageGraph(pool: Pool, tenantId: string): Promise<LineageGraph> {
  return withTenant(pool, tenantId, async (client) => {
    const edges = await client.query<{ relationship_id: string; from_asset_id: string; to_asset_id: string; granularity: string; methods: EvidenceMethod[]; review_statuses: string[]; verifications: string[]; evidence: number; explanations: string[]; transformations: string[]; collectors: string[] }>(
      `SELECT r.relationship_id,r.from_asset_id,r.to_asset_id,r.granularity,array_agg(DISTINCT a.evidence_method) AS methods,array_agg(DISTINCT a.review_status) AS review_statuses,
         array_agg(DISTINCT a.verification) AS verifications,sum(cardinality(a.evidence_ids))::int AS evidence,array_remove(array_agg(DISTINCT a.explanation),NULL) AS explanations,
         array_remove(array_agg(DISTINCT a.transformation->>'kind'),NULL) AS transformations,array_agg(DISTINCT a.collector_version) AS collectors
       FROM graph.relationships r JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id AND a.valid_to IS NULL AND a.review_status NOT IN ('rejected','stale')
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active
       WHERE r.tenant_id=$1 AND r.family='data_flow' AND r.granularity IN ('dataset','field') GROUP BY r.tenant_id,r.relationship_id`, [tenantId]);
    const gaps = await client.query<{ gap_id: string; asset_id: string; reason: string }>(
      `SELECT g.gap_id,unnest(g.between_asset_ids) AS asset_id,g.reason FROM graph.gaps g WHERE g.tenant_id=$1 AND g.closed_by_assertion_id IS NULL`, [tenantId]);
    const fieldIds = new Set<string>(); const datasetIds = new Set<string>();
    for (const edge of edges.rows) for (const id of [edge.from_asset_id, edge.to_asset_id]) (edge.granularity === 'field' ? fieldIds : datasetIds).add(id);
    for (const gap of gaps.rows) { fieldIds.add(gap.asset_id); datasetIds.add(gap.asset_id); }
    const fields = await client.query<{ asset_id: string; dataset_id: string; qualified_name: string; data_type: string | null }>(
      `SELECT f.asset_id,c.from_asset_id AS dataset_id,f.qualified_name,p.data_type FROM graph.assets f
       JOIN graph.relationships c ON c.tenant_id=f.tenant_id AND c.to_asset_id=f.asset_id AND c.relationship_type='CONTAINS'
       LEFT JOIN LATERAL(SELECT data_type FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       WHERE f.tenant_id=$1 AND f.asset_type='field' AND f.active AND f.asset_id=ANY($2::uuid[])`, [tenantId, [...fieldIds]]);
    for (const field of fields.rows) datasetIds.add(field.dataset_id);
    const datasets = await client.query<{ asset_id: string; qualified_name: string; source_id: string; source_name: string; connector_type: string; object_type: string | null }>(
      `SELECT d.asset_id,d.qualified_name,d.source_id,coalesce(nullif(c.display_name,''),c.connector_type) AS source_name,c.connector_type,v.structural_attributes->>'object_type' AS object_type
       FROM graph.assets d JOIN registry.connections c ON c.tenant_id=d.tenant_id AND c.connection_id=d.source_id
       LEFT JOIN LATERAL(SELECT structural_attributes FROM graph.asset_versions WHERE tenant_id=d.tenant_id AND asset_id=d.asset_id ORDER BY version DESC LIMIT 1)v ON true
       WHERE d.tenant_id=$1 AND d.asset_type='dataset' AND d.active AND d.asset_id=ANY($2::uuid[]) ORDER BY d.qualified_name`, [tenantId, [...datasetIds]]);
    const toEdge = (row: typeof edges.rows[number]): LineageGraphEdge => {
      const methods = ORDER.filter((method) => row.methods.includes(method));
      return { relationshipId: row.relationship_id, from: row.from_asset_id, to: row.to_asset_id, methods, method: methods[0] ?? 'inferred',
        reviewStatus: row.review_statuses.includes('accepted') ? 'accepted' : row.review_statuses.includes('disputed') ? 'disputed' : 'unreviewed',
        verification: row.verifications.includes('reconciled') ? 'reconciled' : row.verifications.includes('run_verified') ? 'run_verified' : 'unverified',
        evidenceCount: row.evidence, explanations: row.explanations, transformation: row.transformations.includes('derived') ? 'derived' : row.transformations[0] ?? null, collectors: row.collectors };
    };
    const datasetSet = new Set(datasets.rows.map((row) => row.asset_id));
    const fieldSet = new Set(fields.rows.map((row) => row.asset_id));
    return {
      datasets: datasets.rows.map((row) => ({ assetId: row.asset_id, name: row.qualified_name, sourceId: row.source_id, sourceName: row.source_name, connectorType: row.connector_type, objectType: row.object_type })),
      fields: fields.rows.map((row) => ({ assetId: row.asset_id, datasetId: row.dataset_id, name: row.qualified_name.slice(row.qualified_name.lastIndexOf('.') + 1), dataType: row.data_type })),
      tableEdges: edges.rows.filter((row) => row.granularity === 'dataset' && datasetSet.has(row.from_asset_id) && datasetSet.has(row.to_asset_id)).map(toEdge),
      columnEdges: edges.rows.filter((row) => row.granularity === 'field' && fieldSet.has(row.from_asset_id) && fieldSet.has(row.to_asset_id)).map(toEdge),
      gaps: gaps.rows.filter((row) => datasetSet.has(row.asset_id) || fieldSet.has(row.asset_id)).map((row) => ({ gapId: row.gap_id, assetId: row.asset_id, reason: row.reason })),
    };
  });
}

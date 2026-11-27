import { createHash, randomUUID } from 'node:crypto';
import { ClaimSchema, EvidenceRefSchema, type Claim, type EvidenceRef } from '@scaleinsyght/contracts';
import { withTenant, type Pool } from '@scaleinsyght/db';
import { queryLineage } from './index.js';

type Method = 'declared' | 'parsed' | 'observed' | 'inferred';
export type LineageSummary = {
  asset: string; direction: 'upstream' | 'downstream'; sourceName: string;
  steps: Array<{ from: string; to: string; method: Method; how: string; hop: number }>;
  gaps: Array<{ asset: string; reason: string }>;
  methods: Record<Method | 'gap', number>;
};
const LABEL: Record<Method, string> = { declared: 'Declared', parsed: 'Parsed', observed: 'Observed', inferred: 'Inferred' };
const RANK: Method[] = ['declared', 'parsed', 'observed', 'inferred'];

/** Answers a lineage request from recorded assertions only. Statements are written by code from the graph; each cites
 * the evidence behind its link, gaps are stated as gaps, and an inferred link is never presented as verified. */
export async function answerLineageRequest(pool: Pool, input: { tenantId: string; sourceId: string; sourceName: string; asset: string; direction: 'upstream' | 'downstream' }): Promise<{ value: number; lineage: LineageSummary; claims: Claim[]; evidence: EvidenceRef[] }> {
  const start = await withTenant(pool, input.tenantId, (client) => client.query<{ asset_id: string }>(
    `SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name=$3 AND active AND asset_type IN ('dataset','field') AND (source_id=$2 OR source_id IN (SELECT connection_id FROM registry.connections WHERE tenant_id=$1 AND connector_type='dbt' AND status='active' AND source_ref='warehouse:'||$2::text)) ORDER BY (source_id=$2) DESC LIMIT 1`, [input.tenantId, input.sourceId, input.asset]));
  const assetId = start.rows[0]?.asset_id;
  if (!assetId) throw new Error('lineage_asset_not_found');
  const path = await queryLineage(pool, { tenantId: input.tenantId, assetId, direction: input.direction });
  const names = new Map(path.assets.map((asset) => [asset.asset_id, asset.qualified_name]));
  const assertionsBy = new Map<string, typeof path.assertions>();
  for (const assertion of path.assertions) if (!assertion.valid_to) assertionsBy.set(assertion.relationship_id, [...(assertionsBy.get(assertion.relationship_id) ?? []), assertion]);
  // Hop distance from the asked-about asset, walking in the asked direction.
  const hop = new Map<string, number>([[assetId, 0]]); let frontier = [assetId];
  for (let depth = 1; frontier.length && depth <= 20; depth++) {
    const next: string[] = [];
    for (const edge of path.edges) {
      const [near, far] = input.direction === 'upstream' ? [edge.to_asset_id, edge.from_asset_id] : [edge.from_asset_id, edge.to_asset_id];
      if (frontier.includes(near) && !hop.has(far) && assertionsBy.has(edge.relationship_id)) { hop.set(far, depth); next.push(far); }
    }
    frontier = next;
  }
  const evidenceRows = new Map(path.evidence.map((row) => [row.evidence_id, row]));
  const evidence: EvidenceRef[] = []; const claims: Claim[] = []; const steps: LineageSummary['steps'] = [];
  const methods: LineageSummary['methods'] = { declared: 0, parsed: 0, observed: 0, inferred: 0, gap: 0 };
  const cite = (ids: string[]) => ids.filter((id) => evidenceRows.has(id)).map((id) => {
    if (!evidence.some((ref) => ref.evidence_id === id)) {
      const row = evidenceRows.get(id)!; const metadata = row.safe_metadata as { statement_hash?: unknown; collector?: unknown };
      evidence.push(EvidenceRefSchema.parse({ evidence_id: id, kind: row.evidence_type === 'dbt_manifest' || row.evidence_type === 'manifest' ? 'manifest' : row.evidence_type.startsWith('parsed') ? 'code' : 'profile',
        source_id: input.sourceId, asset_ids: [assetId], locator: `${input.sourceName} · lineage of ${input.asset}`,
        content_hash: typeof metadata.statement_hash === 'string' && /^[a-f0-9]{64}$/.test(metadata.statement_hash) ? metadata.statement_hash : createHash('sha256').update(id).digest('hex'),
        captured_at: row.captured_at, collector_version: typeof metadata.collector === 'string' ? metadata.collector.slice(0, 100) : row.evidence_type,
        redacted_summary: row.evidence_type === 'dbt_manifest' ? 'Dependency declared in the uploaded dbt manifest; column flow parsed from its compiled SQL.' : 'Data flow parsed from the source\'s view SQL.' }));
    }
    return id;
  });
  for (const edge of path.edges) {
    const assertions = assertionsBy.get(edge.relationship_id); if (!assertions?.length) continue;
    const far = input.direction === 'upstream' ? edge.from_asset_id : edge.to_asset_id; if (!hop.has(far)) continue;
    const method = RANK.find((item) => assertions.some((assertion) => assertion.evidence_method === item)) ?? 'inferred';
    const derived = assertions.some((assertion) => (assertion.transformation as { kind?: unknown } | null)?.kind === 'derived');
    const how = `${LABEL[method]}${method === 'inferred' ? ', not verified' : ''}: ${derived ? 'computed from' : edge.granularity === 'dataset' ? 'built from' : 'copied from'} ${names.get(edge.from_asset_id)}`;
    steps.push({ from: names.get(edge.from_asset_id) ?? '', to: names.get(edge.to_asset_id) ?? '', method, how, hop: hop.get(far)! });
    methods[method]++;
    const ids = cite(assertions.flatMap((assertion) => assertion.evidence_ids));
    if (ids.length) claims.push(ClaimSchema.parse({ claim_id: randomUUID(), kind: 'lineage', statement: `${names.get(edge.to_asset_id)} is ${derived ? 'computed from' : edge.granularity === 'dataset' ? 'built from' : 'copied from'} ${names.get(edge.from_asset_id)} (${LABEL[method].toLowerCase()}${method === 'inferred' ? ', not verified' : ''}).`, evidence_ids: ids }));
  }
  steps.sort((a, b) => a.hop - b.hop || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const gaps = path.gaps.filter(gap => !gap.closed_by_assertion_id).flatMap((gap) => gap.between_asset_ids.filter((id) => hop.has(id)).map((id) => ({ asset: names.get(id) ?? '', reason: gap.reason })));
  methods.gap = gaps.length;
  const related = [...hop.keys()].filter((id) => id !== assetId).length;
  const summary = input.direction === 'upstream'
    ? related ? `${input.asset} comes from ${related} upstream ${related === 1 ? 'object' : 'objects'} through ${steps.length} recorded ${steps.length === 1 ? 'link' : 'links'}${gaps.length ? `, with ${gaps.length} missing ${gaps.length === 1 ? 'link' : 'links'}` : ''}.` : `No recorded lineage shows where ${input.asset} comes from${gaps.length ? `; ${gaps.length} missing ${gaps.length === 1 ? 'link is' : 'links are'} recorded` : ''}.`
    : related ? `${related} downstream ${related === 1 ? 'object reads' : 'objects read'} ${input.asset} through ${steps.length} recorded ${steps.length === 1 ? 'link' : 'links'}; a change to it affects them.` : `No recorded lineage shows anything that reads ${input.asset}.`;
  const summaryEvidence = evidence.map((ref) => ref.evidence_id);
  if (!summaryEvidence.length) {
    // No links: the answer still cites the profile that recorded the asset.
    const profileEvidence = randomUUID();
    evidence.push(EvidenceRefSchema.parse({ evidence_id: profileEvidence, kind: 'profile', source_id: input.sourceId, asset_ids: [assetId], locator: `${input.sourceName} · lineage of ${input.asset}`,
      content_hash: createHash('sha256').update(`${input.sourceId}\0${input.asset}`).digest('hex'), captured_at: new Date().toISOString(), collector_version: 'lineage-graph-v1', redacted_summary: 'No data-flow assertions are recorded for this object.' }));
    summaryEvidence.push(profileEvidence);
  }
  claims.unshift(ClaimSchema.parse({ claim_id: randomUUID(), kind: 'lineage', statement: summary, evidence_ids: summaryEvidence }));
  // Gaps are uncertainties, not claims: they travel in lineage.gaps and are shown as missing links.
  return { value: related, lineage: { asset: input.asset, direction: input.direction, sourceName: input.sourceName, steps, gaps, methods }, claims, evidence };
}

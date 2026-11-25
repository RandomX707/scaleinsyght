import type { Pool } from 'pg';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';
import { fingerprintIdentifier } from '@scaleinsyght/graph';

/** Fields with more distinct values than this are listed as identifier fields but not fingerprinted. */
export const ID_FINGERPRINT_LIMIT = 1_000_000;
/** A cross-source match needs this many shared values, and this share of the smaller set matched. */
const MIN_SHARED = 20;
const MIN_CONTAINMENT = 0.98;
const COLLECTOR = 'id-agent-v1';

type Candidate = { assetId: string; name: string; table: string; column: string; tagged: boolean; declared: boolean; home: string | null };

/** Values are sorted into a coarse format so only like-shaped identifiers are compared. Computed in memory. */
export function formatPattern(values: string[]): string {
  if (!values.length) return 'empty';
  const all = (test: (value: string) => boolean) => values.every(test);
  if (all((value) => /^-?\d+$/.test(value))) return 'integer';
  if (all((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return 'uuid';
  if (all((value) => /^[A-Za-z]{1,6}[-_]?\d{3,}$/.test(value))) return 'letters_digits_code';
  return 'text';
}

/** The ID agent (CLAUDE.md section 7). For one connection: finds identifier fields (columns tagged identifier and the
 * key columns joined to them), stores each distinct value only as a keyed fingerprint (HMAC with a per-tenant key,
 * non-negotiable 6), and proposes probable SAME_AS matches with other connections' identifier fields from fingerprint
 * overlap. Raw values are read, fingerprinted and dropped in this process; none is stored, logged or sent to a model. */
export async function runIdAgent(pool: Pool, input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector; masterKey?: Uint8Array }): Promise<{ fields: number; fingerprinted: number; matches: number } | undefined> {
  if (!input.masterKey || input.masterKey.byteLength < 32 || !input.connector.distinctValues) return undefined;
  const candidates = await withTenant(pool, input.tenantId, async (client) => {
    const fields = await client.query<{ asset_id: string; qualified_name: string; table_name: string; tags: string[] | null; evidence: Array<{ tag: string; detection: string }> | null }>(
      `SELECT f.asset_id,f.qualified_name,d.qualified_name AS table_name,p.sensitivity_tags AS tags,p.sensitivity_evidence AS evidence FROM graph.assets f
       JOIN graph.relationships c ON c.tenant_id=f.tenant_id AND c.to_asset_id=f.asset_id AND c.relationship_type='CONTAINS'
       JOIN graph.assets d ON d.tenant_id=c.tenant_id AND d.asset_id=c.from_asset_id AND d.active
       LEFT JOIN LATERAL(SELECT sensitivity_tags,sensitivity_evidence FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       WHERE f.tenant_id=$1 AND f.source_id=$2 AND f.asset_type='field' AND f.active`, [input.tenantId, input.connectionId]);
    const references = await client.query<{ from_id: string; to_id: string }>(
      `SELECT r.from_asset_id AS from_id,r.to_asset_id AS to_id FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id
       WHERE r.tenant_id=$1 AND f.source_id=$2 AND r.relationship_type='REFERENCES' AND EXISTS(SELECT 1 FROM graph.assertions a WHERE a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
         AND a.valid_to IS NULL AND a.review_status NOT IN ('rejected','stale') AND (a.evidence_method='declared' OR a.confidence_score>=0.98))`, [input.tenantId, input.connectionId]);
    const byId = new Map(fields.rows.map((row) => [row.asset_id, row]));
    const keyed = new Set(references.rows.flatMap((row) => [row.from_id, row.to_id]));
    const homeOf = new Map<string, string>();
    for (const row of references.rows) { homeOf.set(row.from_id, row.to_id); homeOf.set(row.to_id, homeOf.get(row.to_id) ?? row.to_id); }
    return fields.rows.filter((row) => (row.tags ?? []).includes('identifier') || keyed.has(row.asset_id)).map((row): Candidate => {
      const split = row.qualified_name.lastIndexOf('.');
      const home = homeOf.get(row.asset_id); const homeTable = home ? byId.get(home)?.table_name ?? null : null;
      return { assetId: row.asset_id, name: row.qualified_name, table: row.table_name, column: row.qualified_name.slice(split + 1), tagged: (row.tags ?? []).includes('identifier'),
        declared: (row.evidence ?? []).some((item) => item.tag === 'identifier' && item.detection === 'declared'), home: homeTable };
    });
  });
  const read: Array<{ candidate: Candidate; format: string; fingerprints: Buffer[] | null }> = [];
  for (const candidate of candidates) {
    const values = await input.connector.distinctValues(candidate.table, candidate.column, ID_FINGERPRINT_LIMIT);
    read.push({ candidate, format: values ? formatPattern(values) : 'too_many_values', fingerprints: values ? values.map((value) => Buffer.from(fingerprintIdentifier(input.masterKey!, input.tenantId, value), 'hex')) : null });
  }
  return withTenant(pool, input.tenantId, async (client) => {
    let fingerprinted = 0;
    for (const item of read) {
      const { candidate } = item;
      await client.query(
        `INSERT INTO graph.id_fields(tenant_id,asset_id,field_name,entity_hint,format_pattern,detection,confidence,active) VALUES($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT(tenant_id,asset_id,field_name) DO UPDATE SET entity_hint=EXCLUDED.entity_hint,format_pattern=EXCLUDED.format_pattern,detection=EXCLUDED.detection,confidence=EXCLUDED.confidence,active=true,detected_at=clock_timestamp()`,
        [input.tenantId, candidate.assetId, candidate.name, candidate.home ?? candidate.table, item.format, candidate.declared ? 'declared' : 'inferred', candidate.tagged ? 1 : 0.9]);
      // Fingerprints are the field's current value set: replaced on every profile, never mixed across runs.
      await client.query('DELETE FROM graph.id_fingerprints WHERE tenant_id=$1 AND asset_id=$2 AND field_name=$3', [input.tenantId, candidate.assetId, candidate.name]);
      if (item.fingerprints?.length) {
        for (let start = 0; start < item.fingerprints.length; start += 5_000) {
          await client.query(`INSERT INTO graph.id_fingerprints(tenant_id,asset_id,field_name,fingerprint,key_version) SELECT $1,$2,$3,unnest($4::bytea[]),1 ON CONFLICT DO NOTHING`,
            [input.tenantId, candidate.assetId, candidate.name, item.fingerprints.slice(start, start + 5_000)]);
        }
        fingerprinted++;
      }
    }
    await client.query(`UPDATE graph.id_fields i SET active=false FROM graph.assets a WHERE i.tenant_id=$1 AND a.tenant_id=i.tenant_id AND a.asset_id=i.asset_id AND a.source_id=$2 AND NOT (i.asset_id=ANY($3::uuid[]))`,
      [input.tenantId, input.connectionId, candidates.map((candidate) => candidate.assetId)]);
    // Probable matches with other connections, from shared fingerprints only.
    const overlaps = await client.query<{ here: string; there: string; there_source: string; shared: string; here_count: string; there_count: string; here_format: string; there_format: string }>(
      `WITH fields AS(SELECT i.asset_id,a.source_id,i.format_pattern FROM graph.id_fields i JOIN graph.assets a ON a.tenant_id=i.tenant_id AND a.asset_id=i.asset_id AND a.active WHERE i.tenant_id=$1 AND i.active),
         sizes AS(SELECT f.asset_id,count(*) AS n FROM graph.id_fingerprints f JOIN fields USING(asset_id) WHERE f.tenant_id=$1 GROUP BY f.asset_id),
         shared AS(SELECT hf.asset_id AS here,tf.asset_id AS there,count(*) AS n FROM graph.id_fingerprints hf
           JOIN graph.id_fingerprints tf ON tf.tenant_id=hf.tenant_id AND tf.fingerprint=hf.fingerprint AND tf.asset_id<>hf.asset_id
           WHERE hf.tenant_id=$1 AND hf.asset_id IN (SELECT asset_id FROM fields WHERE source_id=$2) AND tf.asset_id IN (SELECT asset_id FROM fields WHERE source_id<>$2)
           GROUP BY hf.asset_id,tf.asset_id)
       SELECT s.here,s.there,t.source_id AS there_source,s.n::text AS shared,hs.n::text AS here_count,ts.n::text AS there_count,h.format_pattern AS here_format,t.format_pattern AS there_format
       FROM shared s JOIN fields h ON h.asset_id=s.here JOIN fields t ON t.asset_id=s.there JOIN sizes hs ON hs.asset_id=s.here JOIN sizes ts ON ts.asset_id=s.there`, [input.tenantId, input.connectionId]);
    // One best match per field and other source: almost all of the smaller set matched, then the closest set size.
    const best = new Map<string, { here: string; there: string; shared: number; hereCount: number; thereCount: number; containment: number; jaccard: number }>();
    for (const row of overlaps.rows) {
      const shared = Number(row.shared); const hereCount = Number(row.here_count); const thereCount = Number(row.there_count);
      const containment = shared / Math.min(hereCount, thereCount); const jaccard = shared / (hereCount + thereCount - shared);
      if (row.here_format !== row.there_format || shared < MIN_SHARED || containment < MIN_CONTAINMENT) continue;
      const key = `${row.here}\0${row.there_source}`; const current = best.get(key);
      if (!current || jaccard > current.jaccard) best.set(key, { here: row.here, there: row.there, shared, hereCount, thereCount, containment, jaccard });
    }
    const kept = new Set<string>();
    for (const match of best.values()) {
      const [from, to] = match.here < match.there ? [match.here, match.there] : [match.there, match.here];
      const relationship = await client.query<{ relationship_id: string }>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','SAME_AS',$2,$3,'field')
         ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`, [input.tenantId, from, to]);
      const relationshipId = relationship.rows[0]!.relationship_id; kept.add(relationshipId);
      const counts = { shared: match.shared, here_count: match.hereCount, there_count: match.thereCount };
      const current = await client.query<{ assertion_id: string; matched: Record<string, number> | null }>(
        `SELECT a.assertion_id,e.safe_metadata AS matched FROM graph.assertions a JOIN graph.evidence e ON e.tenant_id=a.tenant_id AND e.evidence_id=a.evidence_ids[1]
         WHERE a.tenant_id=$1 AND a.relationship_id=$2 AND a.collector_version=$3 AND a.valid_to IS NULL`, [input.tenantId, relationshipId, COLLECTOR]);
      const same = current.rows[0] && current.rows[0].matched?.shared === match.shared && Math.min(current.rows[0].matched.here_count ?? 0, current.rows[0].matched.there_count ?? 0) === Math.min(match.hereCount, match.thereCount);
      if (same) continue;
      if (current.rows[0]) await client.query('UPDATE graph.assertions SET valid_to=clock_timestamp() WHERE tenant_id=$1 AND assertion_id=$2', [input.tenantId, current.rows[0].assertion_id]);
      const evidence = await client.query<{ evidence_id: string }>(`INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'fingerprint_overlap',$2::jsonb) RETURNING evidence_id`,
        [input.tenantId, JSON.stringify({ collector: COLLECTOR, ...counts })]);
      await client.query(`INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version) VALUES($1,$2,'inferred',$3,$4,$5,$6)`,
        [input.tenantId, relationshipId, [evidence.rows[0]!.evidence_id], Number(match.containment.toFixed(4)),
          `${match.shared.toLocaleString('en-US')} of ${Math.min(match.hereCount, match.thereCount).toLocaleString('en-US')} values in the smaller field match by keyed fingerprint`, COLLECTOR]);
    }
    // Matches this connection no longer supports are closed, never deleted (contract 6).
    await client.query(
      `UPDATE graph.assertions a SET valid_to=clock_timestamp() FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       WHERE a.tenant_id=$1 AND r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id AND r.relationship_type='SAME_AS' AND a.collector_version=$3 AND a.valid_to IS NULL
         AND (f.source_id=$2 OR t.source_id=$2) AND NOT (r.relationship_id=ANY($4::uuid[]))`, [input.tenantId, input.connectionId, COLLECTOR, [...kept]]);
    return { fields: candidates.length, fingerprinted, matches: best.size };
  });
}

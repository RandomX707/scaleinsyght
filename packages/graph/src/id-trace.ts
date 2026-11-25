import { withTenant, type Pool } from '@scaleinsyght/db';
import { fingerprintIdentifier } from './index.js';

export type IdRole = 'created' | 'kept' | 'key changed';
export type IdEntity = {
  entityId: string; label: string; home: string;
  fields: Array<{ assetId: string; field: string; sourceId: string; sourceName: string; connectorType: string; distinct: number; tagged: boolean; format: string;
    role: IdRole; probable: boolean; sharedWithHome: number | null; evidence: Array<{ method: string; explanation: string | null; confidence: number | null }> }>;
};

/** Identifier entities for the ID trace screen. Fields are grouped by trusted references inside a source and by
 * probable SAME_AS matches across sources; only groups holding a field tagged as an identifier are listed. Every count
 * is computed from keyed fingerprints; no identifier value is read or returned. */
export async function listIdEntities(pool: Pool, tenantId: string): Promise<IdEntity[]> {
  return withTenant(pool, tenantId, async (client) => {
    const fields = await client.query<{ asset_id: string; field_name: string; source_id: string; source_name: string; connector_type: string; format_pattern: string; confidence: string; distinct: string }>(
      `SELECT i.asset_id,i.field_name,a.source_id,coalesce(nullif(c.display_name,''),c.connector_type) AS source_name,c.connector_type,i.format_pattern,i.confidence::text,
         (SELECT count(*) FROM graph.id_fingerprints f WHERE f.tenant_id=i.tenant_id AND f.asset_id=i.asset_id)::text AS distinct
       FROM graph.id_fields i JOIN graph.assets a ON a.tenant_id=i.tenant_id AND a.asset_id=i.asset_id AND a.active
       JOIN registry.connections c ON c.tenant_id=a.tenant_id AND c.connection_id=a.source_id AND c.status='active'
       WHERE i.tenant_id=$1 AND i.active ORDER BY i.field_name`, [tenantId]);
    const ids = fields.rows.map((row) => row.asset_id);
    const links = await client.query<{ from_id: string; to_id: string; relationship_type: string; method: string; explanation: string | null; confidence: string | null }>(
      `SELECT r.from_asset_id AS from_id,r.to_asset_id AS to_id,r.relationship_type,a.evidence_method AS method,a.explanation,a.confidence_score::text AS confidence
       FROM graph.relationships r JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id AND a.valid_to IS NULL AND a.review_status NOT IN ('rejected','stale')
       WHERE r.tenant_id=$1 AND r.relationship_type IN ('REFERENCES','SAME_AS') AND r.from_asset_id=ANY($2::uuid[]) AND r.to_asset_id=ANY($2::uuid[])
         AND (r.relationship_type='SAME_AS' OR a.evidence_method='declared' OR a.confidence_score>=0.98)`, [tenantId, ids]);
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (id: string): string => { const up = parent.get(id)!; if (up === id) return id; const root = find(up); parent.set(id, root); return root; };
    for (const link of links.rows) parent.set(find(link.from_id), find(link.to_id));
    const groups = new Map<string, typeof fields.rows>();
    for (const row of fields.rows) groups.set(find(row.asset_id), [...(groups.get(find(row.asset_id)) ?? []), row]);
    const entities: IdEntity[] = [];
    for (const members of groups.values()) {
      if (!members.some((row) => Number(row.confidence) === 1)) continue; // only groups that hold a tagged identifier
      const inbound = (id: string) => links.rows.filter((link) => link.relationship_type === 'REFERENCES' && link.to_id === id).length;
      // The origin is the field holding the most values (the system of record); ties go to the key most fields
      // reference, then the name.
      const home = [...members].sort((a, b) => Number(b.distinct) - Number(a.distinct) || inbound(b.asset_id) - inbound(a.asset_id) || a.field_name.localeCompare(b.field_name))[0]!;
      const homeColumn = home.field_name.slice(home.field_name.lastIndexOf('.') + 1);
      const shared = await client.query<{ asset_id: string; shared: string }>(
        `SELECT f.asset_id,count(*)::text AS shared FROM graph.id_fingerprints f JOIN graph.id_fingerprints h ON h.tenant_id=f.tenant_id AND h.asset_id=$2 AND h.fingerprint=f.fingerprint
         WHERE f.tenant_id=$1 AND f.asset_id=ANY($3::uuid[]) GROUP BY f.asset_id`, [tenantId, home.asset_id, members.map((row) => row.asset_id)]);
      const sharedBy = new Map(shared.rows.map((row) => [row.asset_id, Number(row.shared)]));
      entities.push({ entityId: home.asset_id, home: home.field_name, label: `${homeColumn} · ${home.field_name.slice(0, home.field_name.lastIndexOf('.'))}`,
        fields: members.map((row) => {
          const column = row.field_name.slice(row.field_name.lastIndexOf('.') + 1);
          const evidence = links.rows.filter((link) => link.from_id === row.asset_id || link.to_id === row.asset_id);
          return { assetId: row.asset_id, field: row.field_name, sourceId: row.source_id, sourceName: row.source_name, connectorType: row.connector_type, distinct: Number(row.distinct),
            tagged: Number(row.confidence) === 1, format: row.format_pattern,
            role: (row.asset_id === home.asset_id ? 'created' : column === homeColumn ? 'kept' : 'key changed') as IdRole,
            // Inside a source fields are joined by trusted references; reaching another source always crosses a probable match.
            probable: row.source_id !== home.source_id,
            sharedWithHome: row.format_pattern === 'too_many_values' ? null : sharedBy.get(row.asset_id) ?? 0,
            evidence: evidence.map((link) => ({ method: link.relationship_type === 'SAME_AS' ? `${link.method} SAME_AS` : `${link.method} reference`, explanation: link.explanation, confidence: link.confidence === null ? null : Number(link.confidence) })) };
        }).sort((a, b) => Number(b.role === 'created') - Number(a.role === 'created') || a.sourceName.localeCompare(b.sourceName) || a.field.localeCompare(b.field)) });
    }
    return entities.sort((a, b) => b.fields.length - a.fields.length || a.label.localeCompare(b.label));
  });
}

/** Where one value appears, from its keyed fingerprint. The value is used only to compute the fingerprint here; it is
 * never stored, logged, returned or sent to a model. Results reflect each source's last profile. */
export async function lookupIdentifierValue(pool: Pool, input: { tenantId: string; value: string; masterKey: Uint8Array }): Promise<Array<{ assetId: string; field: string; sourceName: string }>> {
  if (typeof input.value !== 'string' || input.value.trim().length < 1 || input.value.length > 256) throw new Error('invalid_identifier_value');
  const fingerprint = Buffer.from(fingerprintIdentifier(input.masterKey, input.tenantId, input.value.trim()), 'hex');
  return withTenant(pool, input.tenantId, async (client) => (await client.query<{ asset_id: string; field_name: string; source_name: string }>(
    `SELECT f.asset_id,f.field_name,coalesce(nullif(c.display_name,''),c.connector_type) AS source_name FROM graph.id_fingerprints f
     JOIN graph.id_fields i ON i.tenant_id=f.tenant_id AND i.asset_id=f.asset_id AND i.field_name=f.field_name AND i.active
     JOIN graph.assets a ON a.tenant_id=f.tenant_id AND a.asset_id=f.asset_id JOIN registry.connections c ON c.tenant_id=a.tenant_id AND c.connection_id=a.source_id AND c.status='active'
     WHERE f.tenant_id=$1 AND f.fingerprint=$2 ORDER BY source_name,f.field_name`, [input.tenantId, fingerprint])).rows.map((row) => ({ assetId: row.asset_id, field: row.field_name, sourceName: row.source_name })));
}

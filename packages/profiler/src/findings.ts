import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';

/** A row count that moves by at least this share (and at least ROW_CHANGE_MIN rows) between runs is a data anomaly. */
export const ROW_CHANGE_SHARE = 0.2;
const ROW_CHANGE_MIN = 10;

type Column = { name: string; data_type: string };
export type ProfileState = {
  hadProfile: boolean;
  datasets: Map<string, { assetId: string; columns: Column[]; rowCount: number | null }>;
  inferredTags: Map<string, Set<string>>;
};

/** The connection's state as the graph records it: active tables with their latest columns and row count, and the
 * inferred tags on each field. Read before a run and after it to find what changed. */
export async function readProfileState(pool: Pool, tenantId: string, connectionId: string): Promise<ProfileState> {
  return withTenant(pool, tenantId, async (client) => {
    const jobs = await client.query("SELECT 1 FROM profiler.jobs WHERE tenant_id=$1 AND connection_id=$2 AND state='COMPLETED' LIMIT 1", [tenantId, connectionId]);
    const datasets = await client.query<{ asset_id: string; qualified_name: string; structural: { columns?: Column[] } | null; statistics: { row_count?: number } | null }>(
      `SELECT d.asset_id,d.qualified_name,v.structural_attributes AS structural,v.statistics FROM graph.assets d
       LEFT JOIN LATERAL(SELECT structural_attributes,statistics FROM graph.asset_versions WHERE tenant_id=d.tenant_id AND asset_id=d.asset_id ORDER BY version DESC LIMIT 1)v ON true
       WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.asset_type='dataset' AND d.active`, [tenantId, connectionId]);
    const tags = await client.query<{ qualified_name: string; evidence: Array<{ tag: string; detection: string }> | null }>(
      `SELECT f.qualified_name,p.sensitivity_evidence AS evidence FROM graph.assets f
       JOIN LATERAL(SELECT sensitivity_evidence FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       WHERE f.tenant_id=$1 AND f.source_id=$2 AND f.asset_type='field' AND f.active`, [tenantId, connectionId]);
    return {
      hadProfile: Boolean(jobs.rowCount),
      datasets: new Map(datasets.rows.map((row) => [row.qualified_name, { assetId: row.asset_id, columns: row.structural?.columns ?? [], rowCount: typeof row.statistics?.row_count === 'number' ? row.statistics.row_count : null }])),
      inferredTags: new Map(tags.rows.map((row) => [row.qualified_name, new Set((row.evidence ?? []).filter((item) => item.detection === 'inferred').map((item) => item.tag))])),
    };
  });
}

/** Compares the state after a run with the state before it and records one finding per change (decision 48): new and
 * dropped tables, added, removed or retyped columns, large row-count changes, newly inferred sensitive columns, and
 * probable relationships and ID matches not yet reviewed. Only names and counts are stored, never values. */
export async function recordFindings(pool: Pool, input: { tenantId: string; connectionId: string; jobId: string; before: ProfileState; scannedObjects: Set<string>; checked: number }): Promise<number> {
  const after = await readProfileState(pool, input.tenantId, input.connectionId);
  return withTenant(pool, input.tenantId, async (client) => {
    let count = 0;
    const changed = new Set<string>();
    let checked=input.checked;
    const add = async (kind: string, subject: string, detail: Record<string, unknown>, assetId: string | null, assertionId: string | null = null) => {
      const inserted = await client.query(
        `INSERT INTO profiler.findings(tenant_id,connection_id,job_id,kind,subject,detail,asset_id,assertion_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING`,
        [input.tenantId, input.connectionId, input.jobId, kind, subject.slice(0, 500), JSON.stringify(detail), assetId, assertionId]);
      count += inserted.rowCount ?? 0;
    };
    if (input.before.hadProfile) {
      for (const [name, table] of after.datasets) {
        const previous = input.before.datasets.get(name);
        if (!previous) { changed.add(name); await add('new_tables', name, { columns: table.columns.length, rows: table.rowCount }, table.assetId); continue; }
        if (!input.scannedObjects.has(name)) continue; // unchanged objects are skipped by a nightly run
        const before = new Map(previous.columns.map((column) => [column.name, column.data_type]));
        const now = new Map(table.columns.map((column) => [column.name, column.data_type]));
        const added = [...now.keys()].filter((column) => !before.has(column));
        const removed = [...before.keys()].filter((column) => !now.has(column));
        const retyped = [...now.keys()].filter((column) => before.has(column) && before.get(column) !== now.get(column)).map((column) => ({ column, from: before.get(column), to: now.get(column) }));
        if (added.length || removed.length || retyped.length ||
          (previous.rowCount !== null && table.rowCount !== null && previous.rowCount !== table.rowCount)) changed.add(name);
        if (added.length || removed.length || retyped.length) await add('schema_change', name, { change: 'columns', added, removed, retyped }, table.assetId);
        if (table.rowCount === null) {
          await add('data_anomaly', name, { change: 'count_unavailable' }, table.assetId);
        } else if (previous.rowCount !== null) {
          const change = table.rowCount - previous.rowCount;
          if (Math.abs(change) >= ROW_CHANGE_MIN && Math.abs(change) >= ROW_CHANGE_SHARE * Math.max(previous.rowCount, 1)) await add('data_anomaly', name, { change: 'row_count', before: previous.rowCount, after: table.rowCount }, table.assetId);
        }
      }
      for (const [name, table] of input.before.datasets) if (!after.datasets.has(name)) {
        checked++;
        changed.add(name);
        await add('schema_change', name, { change: 'dropped' }, table.assetId);
      }
    }
    // Newly inferred sensitive columns, to confirm or dismiss. Declared tags need no review.
    const fieldIds = await client.query<{ asset_id: string; qualified_name: string }>(
      "SELECT asset_id,qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND asset_type='field' AND active", [input.tenantId, input.connectionId]);
    const fieldId = new Map(fieldIds.rows.map((row) => [row.qualified_name, row.asset_id]));
    for (const [field, tags] of after.inferredTags) for (const tag of tags) {
      if (input.before.inferredTags.get(field)?.has(tag) && input.before.hadProfile) continue;
      const reviewed = await client.query('SELECT 1 FROM profiler.tag_reviews WHERE tenant_id=$1 AND asset_id=$2 AND tag=$3', [input.tenantId, fieldId.get(field), tag]);
      const open = await client.query("SELECT 1 FROM profiler.findings WHERE tenant_id=$1 AND asset_id=$2 AND kind='sensitive_column' AND detail->>'tag'=$3", [input.tenantId, fieldId.get(field), tag]);
      if (!reviewed.rowCount && !open.rowCount) await add('sensitive_column', field, { tag, detection: 'inferred' }, fieldId.get(field) ?? null);
    }
    // Probable relationships and ID matches touching this connection that have no finding yet.
    const probable = await client.query<{ assertion_id: string; relationship_type: string; from_name: string; to_name: string; confidence: string | null; explanation: string | null }>(
      `SELECT a.assertion_id,r.relationship_type,f.qualified_name AS from_name,t.qualified_name AS to_name,a.confidence_score::text AS confidence,a.explanation
       FROM graph.assertions a JOIN graph.relationships r ON r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       WHERE a.tenant_id=$1 AND a.evidence_method='inferred' AND a.valid_to IS NULL AND a.review_status='unreviewed' AND r.relationship_type IN ('REFERENCES','SAME_AS')
         AND (f.source_id=$2 OR t.source_id=$2) AND (r.relationship_type='SAME_AS' OR a.confidence_score>0.90)
         AND NOT EXISTS(SELECT 1 FROM profiler.findings x WHERE x.tenant_id=a.tenant_id AND x.assertion_id=a.assertion_id)`, [input.tenantId, input.connectionId]);
    for (const row of probable.rows) {
      await add(row.relationship_type === 'SAME_AS' ? 'id_match' : 'probable_relationship', `${row.from_name} → ${row.to_name}`,
        { confidence: row.confidence === null ? null : Number(row.confidence), explanation: row.explanation }, null, row.assertion_id);
    }
    await client.query('UPDATE profiler.jobs SET checked_count=$3,changed_count=$4 WHERE tenant_id=$1 AND job_id=$2',
      [input.tenantId,input.jobId,checked,input.before.hadProfile ? changed.size : null]);
    return count;
  });
}

export type FindingRow = { findingId: string; connectionId: string; sourceName: string; jobId: string; jobType: string; kind: string; subject: string; detail: Record<string, unknown>; foundAt: string; status: string; decidedAt: string | null };

/** Findings for the Approval matrix with the latest nightly run's summary. */
export async function listFindings(pool: Pool, tenantId: string): Promise<{ findings: FindingRow[]; lastNight: { jobIds: string[]; scheduled: boolean; startedAt: string | null; connections: number; profiled: number; listed: number; checked: number | null; changed: number | null } }> {
  return withTenant(pool, tenantId, async (client) => {
    const rows = await client.query<{ finding_id: string; connection_id: string; source_name: string; job_id: string; job_type: string | null; kind: string; subject: string; detail: Record<string, unknown>; found_at: Date; status: string; decided_at: Date | null }>(
      `SELECT f.finding_id,f.connection_id,coalesce(nullif(c.display_name,''),c.connector_type) AS source_name,f.job_id,j.job_type,f.kind,f.subject,f.detail ||
         CASE WHEN f.kind='id_match' AND fc.connection_id IS NOT NULL AND tc.connection_id IS NOT NULL
         THEN jsonb_build_object('fromSource',coalesce(nullif(fc.display_name,''),fc.connector_type),'fromField',fa.qualified_name,
                                 'toSource',coalesce(nullif(tc.display_name,''),tc.connector_type),'toField',ta.qualified_name)
         ELSE '{}'::jsonb END AS detail,f.found_at,f.status,f.decided_at
       FROM profiler.findings f JOIN registry.connections c ON c.tenant_id=f.tenant_id AND c.connection_id=f.connection_id
       LEFT JOIN graph.assertions a ON a.tenant_id=f.tenant_id AND a.assertion_id=f.assertion_id
       LEFT JOIN graph.relationships r ON r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id
       LEFT JOIN graph.assets fa ON fa.tenant_id=r.tenant_id AND fa.asset_id=r.from_asset_id
       LEFT JOIN graph.assets ta ON ta.tenant_id=r.tenant_id AND ta.asset_id=r.to_asset_id
       LEFT JOIN registry.connections fc ON fc.tenant_id=fa.tenant_id AND fc.connection_id=fa.source_id
       LEFT JOIN registry.connections tc ON tc.tenant_id=ta.tenant_id AND tc.connection_id=ta.source_id
       LEFT JOIN profiler.jobs j ON j.tenant_id=f.tenant_id AND j.job_id=f.job_id WHERE f.tenant_id=$1 ORDER BY f.found_at DESC,f.subject LIMIT 500`, [tenantId]);
    // "Last night" is the most recent nightly run of each connection within a day of the newest one.
    const nightly = await client.query<{ job_id: string; scheduled: boolean; created_at: Date; listed_count: number | null; profiled_count: number | null; checked_count: number | null; changed_count: number | null }>(
      `WITH newest AS (SELECT scheduled FROM profiler.jobs WHERE tenant_id=$1 AND job_type='nightly' AND state='COMPLETED' ORDER BY created_at DESC LIMIT 1),
       latest AS(SELECT DISTINCT ON (connection_id) job_id,scheduled,created_at,listed_count,profiled_count,checked_count,changed_count FROM profiler.jobs WHERE tenant_id=$1 AND job_type='nightly' AND state='COMPLETED' AND scheduled=(SELECT scheduled FROM newest) ORDER BY connection_id,created_at DESC)
       SELECT * FROM latest WHERE created_at>=(SELECT max(created_at) FROM latest)-interval '1 day' ORDER BY created_at`, [tenantId]);
    return {
      findings: rows.rows.map((row) => ({ findingId: row.finding_id, connectionId: row.connection_id, sourceName: row.source_name, jobId: row.job_id, jobType: row.job_type ?? 'profile', kind: row.kind, subject: row.subject, detail: row.detail,
        foundAt: row.found_at.toISOString(), status: row.status, decidedAt: row.decided_at?.toISOString() ?? null })),
      lastNight: { scheduled: nightly.rows.at(-1)?.scheduled ?? false, jobIds: nightly.rows.map((row) => row.job_id), startedAt: nightly.rows.at(-1)?.created_at.toISOString() ?? null, connections: nightly.rows.length,
        checked: nightly.rows.length && nightly.rows.every(row=>row.checked_count!==null) ? nightly.rows.reduce((sum,row)=>sum+row.checked_count!,0) : null,
        changed: nightly.rows.length && nightly.rows.every(row=>row.changed_count!==null) ? nightly.rows.reduce((sum,row)=>sum+row.changed_count!,0) : null,
        profiled: nightly.rows.reduce((total, row) => total + Number(row.profiled_count ?? 0), 0), listed: nightly.rows.reduce((total, row) => total + Number(row.listed_count ?? 0), 0) },
    };
  });
}

/** Approves or rejects one open finding, recording who decided and when. A sensitive-column finding confirms or
 * dismisses the inferred tag (a dismissal is audited in tag_reviews and stops the tag being re-applied). A probable
 * relationship or ID match sets the assertion's review status only, never its verification (contract 6). */
export async function decideFinding(pool: Pool, input: { tenantId: string; principalId: string; findingId: string; decision: 'approved' | 'rejected' }): Promise<{ status: string }> {
  return withTenant(pool, input.tenantId, async (client) => {
    const updated = await client.query<{ kind: string; asset_id: string | null; assertion_id: string | null; detail: { tag?: string } }>(
      `UPDATE profiler.findings SET status=$3,decided_by=$4,decided_at=clock_timestamp() WHERE tenant_id=$1 AND finding_id=$2 AND status='open' RETURNING kind,asset_id,assertion_id,detail`,
      [input.tenantId, input.findingId, input.decision, input.principalId]);
    const finding = updated.rows[0];
    if (!finding) throw new Error('finding_not_open');
    if (finding.kind === 'sensitive_column' && finding.asset_id && finding.detail.tag) {
      await client.query(
        `INSERT INTO profiler.tag_reviews(tenant_id,asset_id,tag,decision,decided_by,finding_id) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(tenant_id,asset_id,tag) DO UPDATE SET decision=EXCLUDED.decision,decided_by=EXCLUDED.decided_by,decided_at=clock_timestamp(),finding_id=EXCLUDED.finding_id`,
        [input.tenantId, finding.asset_id, finding.detail.tag, input.decision === 'approved' ? 'confirmed' : 'dismissed', input.principalId, input.findingId]);
    }
    if ((finding.kind === 'probable_relationship' || finding.kind === 'id_match') && finding.assertion_id) {
      await client.query('UPDATE graph.assertions SET review_status=$3,reviewer_id=$4,reviewed_at=clock_timestamp() WHERE tenant_id=$1 AND assertion_id=$2',
        [input.tenantId, finding.assertion_id, input.decision === 'approved' ? 'accepted' : 'rejected', input.principalId]);
    }
    return { status: input.decision };
  });
}

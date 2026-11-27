import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { EncryptedArtifactStore, type StoredArtifact } from '@scaleinsyght/artifacts';
import { objectScope, type ControlsPolicy, type ConnectorScope, type DiscoveryResult, type ObjectProfile, type ReadOnlyConnector, type ScopeMode, type SkippedReference, type TableKeys } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';
import { queueNewObjectReview } from './controls.js';
import { runIdAgent } from './id-agent.js';
import { captureDefinitions } from './definitions.js';
export { analyseDefinition, captureDefinitions, type DefinitionCatalog } from './definitions.js';
import { readProfileState, recordFindings } from './findings.js';
import { isObjectError, sourceErrorCode } from './source-errors.js';
import { detectCopies } from './copies.js';
import { claimDiscovery, finishDiscovery, heartbeat, holdDiscovery, reportDiscovery, StaleDiscoveryJobError, type DiscoveryJob } from './discovery-jobs.js';
import { relinkDbtWarehouseSources, parseStatementLineage, statementHash, writeStatementLineage, SqlParserUnavailable, type LineageDialect, type StatementLineage } from '@scaleinsyght/graph';

export interface ScopeRule {
  qualifiedName: string;
  objectType: string;
  scopeMode: ScopeMode;
}

export interface ProfileSummary {
  jobId: string;
  listed: number;
  profiled: number;
  unchanged: number;
  listOnly: number;
  excluded: number;
  inaccessible: number;
  createdVersions: number;
  elapsedMs: number;
  /** Parsed view lineage (contract 6): views parsed, edges written and gaps recorded. */
  lineage?: { views: number; tableEdges: number; columnEdges: number; gaps: number };
  /** Scrubbed definitions stored for this connection (decision 53). */
  definitions?: { captured: number; changed: number; encrypted: number };
  /** ID agent: identifier fields found, fields fingerprinted and probable cross-source matches. */
  ids?: { fields: number; fingerprinted: number; matches: number };
  /** Findings recorded by comparing this run with the previous state (decision 48). */
  findings?: number;
  /** Objects whose owner was recorded, and procedures or functions found to be copies (decision 62). */
  origins?: { objects: number; copies: number };
}

export async function saveConnectionScope(pool: Pool, tenantId: string, connectionId: string, rules: ScopeRule[]): Promise<void> {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.qualifiedName.trim() || !rule.objectType.trim() || seen.has(rule.qualifiedName)) throw new Error('invalid_scope');
    seen.add(rule.qualifiedName);
  }
  await withTenant(pool, tenantId, async (client) => {
    await client.query('SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND status=$3 FOR UPDATE', [tenantId, connectionId, 'active']);
    await client.query('DELETE FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]);
    for (const rule of rules) {
      await client.query(
        `INSERT INTO registry.connection_scopes(tenant_id,connection_id,qualified_name,object_type,scope_mode)
         VALUES($1,$2,$3,$4,$5)`,
        [tenantId, connectionId, rule.qualifiedName, rule.objectType, rule.scopeMode],
      );
    }
  });
}

export async function readConnectionScope(pool: Pool, tenantId: string, connectionId: string): Promise<ScopeRule[]> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<ScopeRule>(
      `SELECT qualified_name AS "qualifiedName", object_type AS "objectType", scope_mode AS "scopeMode"
       FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 ORDER BY qualified_name`,
      [tenantId, connectionId],
    );
    return result.rows;
  });
}

export function scopeForConnector(rules: ScopeRule[]): ConnectorScope | undefined {
  if (rules.length === 0) return undefined;
  const profile = rules.filter((rule) => rule.scopeMode === 'profile').map((rule) => rule.qualifiedName);
  const listOnly = rules.filter((rule) => rule.scopeMode === 'list_only').map((rule) => rule.qualifiedName);
  const exclude = rules.filter((rule) => rule.scopeMode === 'exclude').map((rule) => rule.qualifiedName);
  const result: ConnectorScope = {};
  if (profile.length) result.profile = profile;
  if (listOnly.length) result.listOnly = listOnly;
  if (exclude.length) result.exclude = exclude;
  return result;
}

export async function readEffectiveScope(pool:Pool, tenantId:string, connectionId:string):Promise<ConnectorScope|undefined> {
  const scope=scopeForConnector(await readConnectionScope(pool,tenantId,connectionId));
  const saved=await withTenant(pool,tenantId,async db=>(await db.query<{policy:ControlsPolicy;known_objects:string[]}>(
    'SELECT policy,known_objects FROM registry.connection_controls WHERE tenant_id=$1 AND connection_id=$2',
    [tenantId,connectionId],
  )).rows[0]);
  return saved ? {...scope,policy:saved.policy,knownObjects:new Set(saved.known_objects)} : scope;
}

/** A query reads a table or column that Controls excludes (or lists only); `objects` names them. */
export class OutOfScopeError extends Error { constructor(readonly objects: string[]) { super('object_out_of_scope'); } }

/** `columns` are read for their values (filters, groups, sums); `joinColumns` only match rows. A masked column may be a join
 * key (its values are compared in the source, never returned); an excluded one may not be used at all. */
export async function checkQueryScope(pool:Pool, tenantId:string, sourceId:string, targets:string[], columns:ReadonlySet<string>, joinColumns:ReadonlySet<string>=new Set()):Promise<ConnectorScope|undefined> {
  const scope=await readEffectiveScope(pool,tenantId,sourceId);
  const catalog=scope?.policy ? await withTenant(pool,tenantId,db=>db.query<{object_name:string;object_type:string}>(
    `SELECT DISTINCT ON (o.object_name) o.object_name,o.object_type
       FROM profiler.job_objects o JOIN profiler.jobs j USING(tenant_id,job_id)
      WHERE j.tenant_id=$1 AND j.connection_id=$2 AND o.object_name=ANY($3::text[])
      ORDER BY o.object_name,j.updated_at DESC`,[tenantId,sourceId,targets])) : undefined;
  const types=new Map(catalog?.rows.map(row=>[row.object_name,row.object_type]));
  const outside=targets.filter(name=>(scope?.policy&&!types.has(name))||objectScope(scope,name,types.get(name)??'table')!=='profile');
  if(outside.length)throw new OutOfScopeError(outside);
  for(const rule of scope?.policy?.columnRules??[]){
    const split=rule.qualifiedName.lastIndexOf('.');
    const name=rule.qualifiedName.slice(split+1);
    if(targets.includes(rule.qualifiedName.slice(0,split))&&(columns.has(name)||(rule.mode==='exclude'&&joinColumns.has(name))))throw new OutOfScopeError([rule.qualifiedName]);
  }
  return scope;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type TimeSkip = (
  { kind: 'table' | 'statistics' | 'identifier'; object: string }
  | ({ kind: 'relationship' } & SkippedReference)
) & { reason: 'source_query_timeout' };

export async function runProfile(
  pool: Pool,
  input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector; jobType: 'discovery' | 'profile' | 'nightly'; scheduled?: boolean;
    /** A claimed background discovery job (decision 57): progress is written as it goes and every write is fenced. */
    job?: DiscoveryJob;
    /** The job's lease heartbeat, kept by the caller until the job is finished (relationships and findings included). */
    beat?: { stop: () => void; lost: () => boolean } },
): Promise<ProfileSummary> {
  const started = performance.now();
  const scope = await readEffectiveScope(pool, input.tenantId, input.connectionId);
  const mode = input.jobType === 'nightly' ? 'nightly' : 'profile';
  const before = await readProfileState(pool, input.tenantId, input.connectionId);
  const job = input.job;
  const ownBeat = job && !input.beat ? heartbeat(pool, job) : null; const beat = input.beat ?? ownBeat;
  // A completed run replaces the outstanding work. Incomplete and reclaimed jobs can add skips, but cannot clear
  // earlier ones because some of their steps may never have run.
  const prior = await withTenant(pool, input.tenantId, async client => (await client.query<{ time_skips: TimeSkip[] }>(
    `SELECT time_skips FROM profiler.jobs
      WHERE tenant_id=$1 AND connection_id=$2 AND time_skips IS NOT NULL
        AND created_at >= coalesce((
          SELECT max(created_at) FROM profiler.jobs
          WHERE tenant_id=$1 AND connection_id=$2 AND state='COMPLETED' AND time_skips IS NOT NULL
        ),'-infinity'::timestamptz)`, [input.tenantId, input.connectionId],
  )).rows.flatMap(row => row.time_skips));
  const timeSkips: TimeSkip[] = [];
  const recordSkips = async (skips: TimeSkip[]) => {
    if (!skips.length) return;
    timeSkips.push(...skips);
    if (!job) return;
    await withTenant(pool, input.tenantId, async client => {
      await holdDiscovery(client, job);
      await client.query(
        `UPDATE profiler.jobs SET time_skips=(
           SELECT jsonb_agg(DISTINCT item)
           FROM jsonb_array_elements(coalesce(time_skips,'[]'::jsonb)||$3::jsonb) AS entries(item)
         ) WHERE tenant_id=$1 AND job_id=$2`, [input.tenantId, job.jobId, JSON.stringify(skips)],
      );
    });
  };
  const discovery: DiscoveryResult = await (async () => { try { return await input.connector.discover(scope ? { mode, scope } : { mode }); } catch (error) { beat?.stop(); throw error; } })();
  const retry = new Set(prior.flatMap(item => item.kind === 'table' || item.kind === 'statistics' ? [item.object] : []));
  const retried = discovery.unchangedObjects.filter(object => retry.has(object.qualifiedName));
  discovery.objects.push(...retried);
  discovery.unchangedObjects = discovery.unchangedObjects.filter(object => !retry.has(object.qualifiedName));
  discovery.unchanged -= retried.length;
  const profiles: Array<{ object: DiscoveryResult['objects'][number]; profile: ObjectProfile }> = [];
  const failed = new Map<string, string>();
  try {
    if (job) await reportDiscovery(pool, job, { phase: 'profiling', listed: discovery.coverage.listed, planned: discovery.objects.length, profiled: 0 });
    let reported = Date.now();
    for (const object of discovery.objects) {
      // One slow or unreadable object does not fail the profile (bug 6): it is recorded and the others carry on. A
      // connection-level failure (login, SSL, unreachable) still stops the job with its reason.
      try {
        if (discovery.timedOutObjects?.has(object.qualifiedName)) throw new Error('source_query_timeout');
        const profile = await input.connector.profile(object.assetKey, scope, mode);
        profiles.push({ object, profile });
        if (profile.limited === 'timeout') await recordSkips([{ kind: 'statistics', object: object.qualifiedName, reason: 'source_query_timeout' }]);
      } catch (error) {
        const code = sourceErrorCode(error);
        if (!isObjectError(code)) throw error;
        failed.set(object.qualifiedName, code);
        if (code === 'source_query_timeout') await recordSkips([{ kind: 'table', object: object.qualifiedName, reason: code }]);
      }
      if (job && (beat?.lost())) throw new StaleDiscoveryJobError();
      const done = profiles.length + failed.size;
      if (job && (Date.now() - reported >= 1000 || done === discovery.objects.length)) { await reportDiscovery(pool, job, { profiled: done }); reported = Date.now(); }
    }
    if (discovery.objects.length && !profiles.length && !timeSkips.length) throw new Error([...failed.values()][0] ?? 'discovery_failed');
  } finally { ownBeat?.stop(); }
  const jobId = job?.jobId ?? randomUUID();
  // Primary keys and indexes, from the catalog (Dictionary "Keys and indexes"). Auxiliary: if they cannot be read the
  // profile carries on and the Dictionary says they were not read.
  let tableKeys: Map<string, TableKeys> | null = null;
  if (input.connector.keysAndIndexes) {
    try { tableKeys = new Map((await input.connector.keysAndIndexes()).map((entry) => [entry.table, entry])); }
    catch (error) { console.error(`Keys and indexes not read for connection ${input.connectionId}: ${sourceErrorCode(error)}`); }
  }
  let createdVersions = 0;
  const structuralReferences = await input.connector.structuralReferences?.(scope) ?? [];
  const referenceChecksSkipped = ('skippedChecks' in structuralReferences ? structuralReferences.skippedChecks : 0) ?? 0;
  if ('timedOutChecks' in structuralReferences) await recordSkips((structuralReferences.timedOutChecks ?? []).map(check => ({
    ...check, kind: 'relationship', reason: 'source_query_timeout',
  })));
  if (referenceChecksSkipped) console.warn(`Profile of connection ${input.connectionId}: ${referenceChecksSkipped} relationship checks skipped`);

  await withTenant(pool, input.tenantId, async (client) => {
    if (job) await holdDiscovery(client, job);
    else await client.query(
      `INSERT INTO profiler.jobs(tenant_id,job_id,connection_id,job_type,state,scheduled)
       VALUES($1,$2,$3,$4,'RUNNING',$5)`,
      [input.tenantId, jobId, input.connectionId, input.jobType, input.scheduled ?? false],
    );
    await client.query(
      // A background job reclaimed after an earlier attempt saved its profile reruns this step: it must not collide
      // with that attempt's rows (test_emr, 27 Nov 2026).
      `INSERT INTO profiler.events(tenant_id,job_id,sequence,event_type,safe_payload)
       VALUES($1,$2,1,'profile_started',$3::jsonb) ON CONFLICT (tenant_id,job_id,sequence) DO NOTHING`,
      [input.tenantId, jobId, JSON.stringify({ connector_type: input.connector.type, job_type: input.jobType })],
    );

    const objectStates = [
      ...discovery.objects.map((object) => failed.has(object.qualifiedName)
        ? { name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'FAILED' as const, assetKey: null }
        : { name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'COMPLETED' as const, assetKey: object.assetKey }),
      ...discovery.unchangedObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'SKIPPED' as const, assetKey: object.assetKey })),
      ...discovery.listOnlyObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'list_only' as const, state: 'SKIPPED' as const, assetKey: null })),
      ...discovery.excludedObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'exclude' as const, state: 'SKIPPED' as const, assetKey: null })),
      ...discovery.inaccessibleObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'INACCESSIBLE' as const, assetKey: null })),
    ];

    // Inferred tags a person dismissed in the Approval matrix are not re-applied; declared tags always stay (decision 48).
    const dismissedRows = await client.query<{ qualified_name: string; tag: string }>(
      `SELECT a.qualified_name,r.tag FROM profiler.tag_reviews r JOIN graph.assets a ON a.tenant_id=r.tenant_id AND a.asset_id=r.asset_id
       WHERE r.tenant_id=$1 AND a.source_id=$2 AND r.decision='dismissed'`, [input.tenantId, input.connectionId]);
    const dismissed = new Map<string, Set<string>>();
    for (const row of dismissedRows.rows) dismissed.set(row.qualified_name, new Set([...(dismissed.get(row.qualified_name) ?? []), row.tag]));
    const tableAssets = new Map<string, string>();
    const fieldAssets = new Map<string, string>();
    for (const { object, profile } of profiles) {
      const datasetId = await ensureAsset(client, input.tenantId, input.connectionId, object.assetKey, 'dataset', object.qualifiedName);
      tableAssets.set(object.qualifiedName, datasetId);
      const keys = tableKeys?.get(object.qualifiedName);
      const structural = { object_type: object.type, columns: profile.columns.map(({ name, dataType, isNullable }) => ({ name, data_type: dataType, nullable: isNullable })),
        ...(tableKeys ? { primary_key: keys?.primaryKey ?? [], indexes: keys?.indexes ?? [] } : {}) };
      const statistics = { row_count: profile.rowCount, ...(profile.rowCountEstimated ? { row_count_estimated: true } : {}) };
      const version = await ensureAssetVersion(client, input.tenantId, datasetId, structural, statistics);
      if (version.created) createdVersions += 1;
      for (const column of profile.columns) {
        const fieldName = `${object.qualifiedName}.${column.name}`;
        const fieldFingerprint = createHash('sha256').update(`${input.connectionId}\0${fieldName}`).digest();
        const fieldAssetId = await ensureAsset(client, input.tenantId, input.connectionId, fieldFingerprint, 'field', fieldName);
        fieldAssets.set(fieldName, fieldAssetId);
        const evidence = column.sensitivityEvidence ?? column.sensitivityTags.map((tag) => ({ tag, detection: 'declared' as const, reason: 'declared by the source' }));
        const keep = (tag: string) => !(dismissed.get(fieldName)?.has(tag) && !evidence.some((item) => item.tag === tag && item.detection === 'declared'));
        const tags = column.sensitivityTags.filter(keep);
        const fieldStructural = { object_type: 'field', data_type: column.dataType, nullable: column.isNullable, sensitivity_tags: [...tags].sort() };
        // Measured statistics are part of the field version: a changed measurement writes a new version and profile row,
        // never overwriting history. Unmeasured and tagged columns keep an empty statistics object.
        const measured = column.statistics.distinctCount === null && column.statistics.nullRate === null ? {}
          : { null_rate: column.statistics.nullRate, distinct_count: column.statistics.distinctCount, average_length: column.statistics.averageLength ?? null, ...(column.statistics.estimated ? { estimated: true } : {}) };
        const fieldVersion = await ensureAssetVersion(client, input.tenantId, fieldAssetId, fieldStructural, measured);
        if (fieldVersion.created) createdVersions += 1;
        await client.query(
          `INSERT INTO profiler.field_profiles(tenant_id,asset_id,profile_version,field_name,data_type,is_nullable,sensitivity_tags,null_rate,distinct_count,display_name,sensitivity_evidence,average_length,statistics_estimated)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
           ON CONFLICT(tenant_id,asset_id,profile_version,field_name) DO NOTHING`,
          [input.tenantId, fieldAssetId, fieldVersion.version, column.name, column.dataType, column.isNullable,
            tags, column.statistics.nullRate, column.statistics.distinctCount,
            column.label && column.label !== column.name ? column.label : null, JSON.stringify(evidence.filter((item) => keep(item.tag))), column.statistics.averageLength ?? null, column.statistics.estimated === true],
        );
        await client.query(
          `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
           VALUES($1,'structural','CONTAINS',$2,$3,'field')
           ON CONFLICT DO NOTHING`,
          [input.tenantId, datasetId, fieldAssetId],
        );
      }
    }

    const unchanged = discovery.unchangedObjects.map(object => object.qualifiedName);
    if (unchanged.length) {
      const fields = await client.query<{ qualified_name: string; asset_id: string }>(
        `SELECT f.qualified_name,f.asset_id FROM graph.assets d
         JOIN graph.relationships r ON r.tenant_id=d.tenant_id AND r.from_asset_id=d.asset_id AND r.relationship_type='CONTAINS'
         JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.to_asset_id AND f.active
         WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.qualified_name=ANY($3::text[])`,
        [input.tenantId,input.connectionId,unchanged]);
      for (const field of fields.rows) fieldAssets.set(field.qualified_name, field.asset_id);
    }
    for (const reference of structuralReferences) {
      const fromId = fieldAssets.get(`${reference.from}.${reference.fromColumn}`);
      const toId = fieldAssets.get(`${reference.to}.${reference.toColumn}`);
      if (!fromId || !toId) continue;
      const relationship = await client.query<{ relationship_id: string }>(
        `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         VALUES($1,'structural','REFERENCES',$2,$3,'field')
         ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
         DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,
        [input.tenantId, fromId, toId],
      );
      const evidenceMethod=reference.evidenceMethod??'declared';
      const existingAssertion = await client.query(
        `SELECT 1 FROM graph.assertions WHERE tenant_id=$1 AND relationship_id=$2 AND evidence_method=$3 LIMIT 1`,
        [input.tenantId, relationship.rows[0]!.relationship_id,evidenceMethod],
      );
      if (!existingAssertion.rowCount) {
        const evidence = await client.query<{ evidence_id: string }>(
          `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata)
           VALUES($1,$2,$3::jsonb)
           RETURNING evidence_id`,
          [input.tenantId,evidenceMethod==='declared'?'declared_foreign_key':'inferred_reference', JSON.stringify({ collector: input.connector.name, connector_type: input.connector.type,from_column:reference.fromColumn,to_column:reference.toColumn })],
        );
        await client.query(
          `INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [input.tenantId, relationship.rows[0]!.relationship_id,evidenceMethod, [evidence.rows[0]!.evidence_id], evidenceMethod==='declared'?1:reference.confidence??0.98,evidenceMethod==='declared'?null:reference.sourceCount===undefined?'Column values matched a primary key during source-local structural analysis.':reference.sampled?`Checked on a sample of ${reference.sourceCount} non-null values: ${reference.matchedCount} of them matched the target primary key.`:`${reference.matchedCount} of ${reference.sourceCount} non-null values matched the target primary key.`, `profile-${input.connector.type}-v1`],
        );
      }
    }

    const inventoryNames=new Set(objectStates.filter(object=>object.mode==='profile'&&object.state!=='INACCESSIBLE').map(object=>object.name));
    const profiledNames=new Set(profiles.map(({object})=>object.qualifiedName));
    const profiledFields=new Set(profiles.flatMap(({object,profile})=>profile.columns.map((column)=>`${object.qualifiedName}.${column.name}`)));
    const existingAssets=await client.query<{asset_id:string;qualified_name:string;asset_type:'dataset'|'field'}>(
      `SELECT asset_id,qualified_name,asset_type FROM graph.assets
       WHERE tenant_id=$1 AND source_id=$2 AND active AND asset_type IN ('dataset','field')`,
      [input.tenantId,input.connectionId]);
    const datasets=existingAssets.rows.filter((asset)=>asset.asset_type==='dataset');
    const staleAssetIds=new Set<string>();
    for(const dataset of datasets)if(!inventoryNames.has(dataset.qualified_name))staleAssetIds.add(dataset.asset_id);
    for(const field of existingAssets.rows.filter((asset)=>asset.asset_type==='field')){
      const parent=datasets.filter((dataset)=>field.qualified_name.startsWith(`${dataset.qualified_name}.`)).sort((left,right)=>right.qualified_name.length-left.qualified_name.length)[0];
      if(!parent)continue;
      if(!inventoryNames.has(parent.qualified_name)||(profiledNames.has(parent.qualified_name)&&!profiledFields.has(field.qualified_name)))staleAssetIds.add(field.asset_id);
    }
    if(staleAssetIds.size){
      const ids=[...staleAssetIds];
      await client.query('UPDATE graph.assets SET active=false,last_seen_at=clock_timestamp() WHERE tenant_id=$1 AND asset_id=ANY($2::uuid[])',[input.tenantId,ids]);
      await client.query(
        `UPDATE graph.assertions a SET review_status='stale'
         FROM graph.relationships r WHERE a.tenant_id=$1 AND a.relationship_id=r.relationship_id
          AND r.tenant_id=a.tenant_id AND (r.from_asset_id=ANY($2::uuid[]) OR r.to_asset_id=ANY($2::uuid[]))`,
        [input.tenantId,ids]);
    }

    for (const row of objectStates) {
      const assetId = row.assetKey ? tableAssets.get(row.name) ?? null : null;
      await client.query(
        `INSERT INTO profiler.job_objects(tenant_id,job_id,object_name,object_type,scope_mode,state,asset_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,job_id,object_name) DO UPDATE SET object_type=EXCLUDED.object_type,scope_mode=EXCLUDED.scope_mode,state=EXCLUDED.state,asset_id=EXCLUDED.asset_id`,
        [input.tenantId, jobId, row.name, row.type, row.mode, row.state, assetId],
      );
    }

    const summary = {
      listed: discovery.coverage.listed,
      profiled: profiles.length,
      unchanged: discovery.unchanged,
      list_only: discovery.listOnlyObjects.length,
      excluded: discovery.excludedObjects.length,
      inaccessible: discovery.coverage.inaccessible,
      limited: profiles.filter(({ profile }) => profile.limited).length,
      failed: failed.size,
      relationship_checks_skipped: referenceChecksSkipped,
    };
    await client.query(
      // A background job stays RUNNING while relationships, lineage and findings are mapped; it completes after them.
      `UPDATE profiler.jobs SET state=$6,phase=CASE WHEN $6='RUNNING' THEN 'relationships' ELSE phase END,state_version=state_version+1,listed_count=$3,profiled_count=$4,inaccessible_count=$5,limited_count=$7,failed_count=$8,time_skips=CASE WHEN $6='RUNNING' THEN time_skips ELSE $9::jsonb END,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND job_id=$2`,
      [input.tenantId, jobId, summary.listed, summary.profiled, summary.inaccessible, job ? 'RUNNING' : 'COMPLETED', summary.limited, summary.failed, JSON.stringify(timeSkips)],
    );
    await client.query(
      `INSERT INTO profiler.events(tenant_id,job_id,sequence,event_type,safe_payload)
       VALUES($1,$2,2,$3,$4::jsonb) ON CONFLICT (tenant_id,job_id,sequence) DO NOTHING`,
      [input.tenantId, jobId, input.jobType === 'nightly' ? 'schema_changed' : 'profile_completed', JSON.stringify(summary)],
    );

    // A nightly refresh notifies only once its findings are recorded, and only if it found something (below).
    if (input.jobType !== 'nightly') await notifyUsers(client, input.tenantId, input.connectionId, jobId, 'discovery', summary);
  });

  const lineage = await collectViewLineage(pool, input);
  const definitions = await captureDefinitions(pool, input);
  const origins = await recordObjectOrigins(pool, input);
  const masterKey = process.env.ARTIFACT_MASTER_KEY ? Buffer.from(process.env.ARTIFACT_MASTER_KEY, 'base64') : undefined;
  if(input.jobType==='nightly'&&scope?.policy?.newObjects==='approve'){
    await queueNewObjectReview(pool,input.tenantId,input.connectionId,discovery.listOnlyObjects.map(object=>object.qualifiedName));
  }
  const ids = await runIdAgent(pool, { ...input,
    onTimeout: object => recordSkips([{ kind: 'identifier', object, reason: 'source_query_timeout' }]), ...(scope?{scope}:{}), ...(masterKey ? { masterKey } : {}),
    ...(job ? { onProgress: (done: number, planned: number) => reportDiscovery(pool, job, { idDone: done, idPlanned: planned }) } : {}) });
  const findings: number = await recordFindings(pool, { tenantId: input.tenantId, connectionId: input.connectionId, jobId, before, inventory:new Set([...discovery.objects,...discovery.unchangedObjects,...discovery.excludedObjects,...discovery.listOnlyObjects,...discovery.inaccessibleObjects].map(object=>object.qualifiedName)), checked: discovery.objects.length + discovery.unchangedObjects.length, scannedObjects: new Set(profiles.map(({ object }) => object.qualifiedName)) });
  if (input.jobType === 'nightly' && findings > 0) {
    const summary = { listed: discovery.coverage.listed, profiled: profiles.length, unchanged: discovery.unchanged, findings };
    await withTenant(pool, input.tenantId, (client) => notifyUsers(client, input.tenantId, input.connectionId, jobId, 'nightly', summary));
  }
  // Every profiled database or workbook connection is refreshed nightly; the first refresh is a day after activation.
  await withTenant(pool, input.tenantId, (client) => client.query(
    `INSERT INTO profiler.nightly_schedules(tenant_id,connection_id,next_run_at) SELECT $1,$2,clock_timestamp()+interval '1 day'
     WHERE EXISTS(SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND status='active') ON CONFLICT DO NOTHING`, [input.tenantId, input.connectionId]));
  await withTenant(pool, input.tenantId, async client => {
    if (job) await holdDiscovery(client, job);
    await client.query('UPDATE profiler.jobs SET id_fields_skipped=$3,time_skips=$4::jsonb WHERE tenant_id=$1 AND job_id=$2',
      [input.tenantId, jobId, ids?.skipped ?? 0, JSON.stringify(timeSkips)]);
  });
  await withTenant(pool, input.tenantId, async client => {
    await relinkDbtWarehouseSources(client, input.tenantId, input.connectionId,
      job ? () => holdDiscovery(client, job) : undefined);
  });
  if (job && !(await finishDiscovery(pool, job, { state: 'COMPLETED' }))) throw new StaleDiscoveryJobError();
  return {
    ...(lineage ? { lineage } : {}),
    definitions,
    ...(origins ? { origins } : {}),
    ...(ids ? { ids } : {}),
    findings,
    jobId,
    listed: discovery.coverage.listed,
    profiled: profiles.length,
    unchanged: discovery.unchanged,
    listOnly: discovery.listOnlyObjects.length,
    excluded: discovery.excludedObjects.length,
    inaccessible: discovery.coverage.inaccessible,
    createdVersions,
    elapsedMs: performance.now() - started,
  };
}

const LINEAGE_DIALECTS: Partial<Record<string, LineageDialect>> = { postgres: 'postgres', sql_server: 'sql_server', snowflake: 'snowflake' };

/** Parses every in-scope view's SQL with the SQLGlot service and writes table and column data flow with parsed evidence.
 * A view whose SQL is hidden, unparseable, or reads something the connection does not expose gets an explicit gap. */
async function collectViewLineage(pool: Pool, input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector }): Promise<ProfileSummary['lineage']> {
  const dialect = LINEAGE_DIALECTS[input.connector.type];
  if (!dialect || !input.connector.viewDefinitions) return undefined;
  const known = await withTenant(pool, input.tenantId, (client) => client.query<{ asset_id: string; qualified_name: string; asset_type: 'dataset' | 'field'; data_type: string | null }>(
    `SELECT a.asset_id,a.qualified_name,a.asset_type,p.data_type FROM graph.assets a
     LEFT JOIN LATERAL(SELECT data_type FROM profiler.field_profiles WHERE tenant_id=a.tenant_id AND asset_id=a.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
     WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.active AND a.asset_type IN ('dataset','field')`, [input.tenantId, input.connectionId]));
  const datasets = new Map(known.rows.filter((row) => row.asset_type === 'dataset').map((row) => [row.qualified_name, row.asset_id]));
  const fields = new Map(known.rows.filter((row) => row.asset_type === 'field').map((row) => [row.qualified_name, row.asset_id]));
  const tables: Record<string, Record<string, string>> = {};
  for (const row of known.rows) {
    if (row.asset_type !== 'field') continue;
    const split = row.qualified_name.lastIndexOf('.'); const table = row.qualified_name.slice(0, split);
    if (datasets.has(table)) (tables[table] ??= {})[row.qualified_name.slice(split + 1)] = row.data_type ?? 'unknown';
  }
  const parsed: Array<{ target: string; hash: string; lineage?: StatementLineage; failure?: string }> = [];
  for (const view of await input.connector.viewDefinitions()) {
    if (!datasets.has(view.qualifiedName)) continue; // out of scope or not profiled: never parsed (non-negotiable 11)
    if (!view.definition) { parsed.push({ target: view.qualifiedName, hash: '', failure: 'The view definition is hidden by the source (for example encrypted), so its lineage is unknown' }); continue; }
    try { parsed.push({ target: view.qualifiedName, hash: statementHash(view.definition), lineage: await parseStatementLineage({ sql: view.definition, dialect, tables, default_schema: view.schema }) }); }
    catch (error) {
      parsed.push({ target: view.qualifiedName, hash: statementHash(view.definition), failure: error instanceof SqlParserUnavailable
        ? 'The SQL parser was unavailable during profiling, so this view\'s lineage was not collected' : `The view SQL could not be parsed (${error instanceof Error ? error.message.replaceAll('_', ' ') : 'parse failed'})` });
    }
  }
  if (!parsed.length) return { views: 0, tableEdges: 0, columnEdges: 0, gaps: 0 };
  return withTenant(pool, input.tenantId, async (client) => {
    const totals = { views: 0, tableEdges: 0, columnEdges: 0, gaps: 0 };
    for (const item of parsed) {
      if (!item.lineage) {
        const targetId = datasets.get(item.target)!;
        const open = await client.query('SELECT 1 FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids=$2::uuid[] AND reason=$3 AND closed_by_assertion_id IS NULL', [input.tenantId, [targetId], item.failure]);
        if (!open.rowCount) await client.query('INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,$2,$3)', [input.tenantId, [targetId], item.failure]);
        totals.gaps++; continue;
      }
      const written = await writeStatementLineage(client, { tenantId: input.tenantId, target: item.target, lineage: item.lineage,
        assets: { dataset: (name) => datasets.get(name), field: (name) => fields.get(name) },
        evidenceMethod: 'parsed', collector: `${input.connector.type}-view-sql-v1`, evidenceType: 'parsed_view_sql', statementHash: item.hash });
      totals.views++; totals.tableEdges += written.tableEdges; totals.columnEdges += written.columnEdges; totals.gaps += written.gaps;
    }
    return totals;
  });
}

async function ensureAsset(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  fingerprint: string | Buffer,
  assetType: 'dataset' | 'field',
  qualifiedName: string,
): Promise<string> {
  const digest = Buffer.isBuffer(fingerprint) ? fingerprint : Buffer.from(fingerprint, 'hex');
  const result = await client.query<{ asset_id: string }>(
    `INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp()
     RETURNING asset_id`,
    [tenantId, sourceId, assetType, qualifiedName, digest],
  );
  return result.rows[0]!.asset_id;
}

async function ensureAssetVersion(
  client: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  assetId: string,
  attributes: Record<string, unknown>,
  statistics: Record<string, unknown>,
): Promise<{ version: number; created: boolean }> {
  const latest = await client.query<{ version: number; structural_attributes: Record<string, unknown>; statistics: Record<string, unknown> }>(
    `SELECT version,structural_attributes,statistics FROM graph.asset_versions
     WHERE tenant_id=$1 AND asset_id=$2 ORDER BY version DESC LIMIT 1`,
    [tenantId, assetId],
  );
  const current = latest.rows[0];
  if (current && canonicalJson(current.structural_attributes) === canonicalJson(attributes) && canonicalJson(current.statistics) === canonicalJson(statistics)) {
    return { version: current.version, created: false };
  }
  const version = (current?.version ?? 0) + 1;
  await client.query(
    `INSERT INTO graph.asset_versions(tenant_id,asset_id,version,structural_attributes,statistics)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [tenantId, assetId, version, JSON.stringify(attributes), JSON.stringify(statistics)],
  );
  return { version, created: true };
}

/** What a notification's job found, by kind: counts only, never names or values. */
export type NotificationCounts = { total: number; tablesChanged: number; tablesDropped: number; newTables: number; newColumns: number; removedColumns: number; retypedColumns: number;
  rowCountChanges: number; countsUnavailable: number; sensitiveColumns: number; probableRelationships: number; idMatches: number };
export type NotificationView = { notificationId: string; type: string; summary: Record<string, unknown>; readAt: string | null; createdAt: string;
  connectionId: string | null; sourceName: string | null; connectorType: string | null; counts: NotificationCounts };

/**
 * A person's notifications, each naming its source and what its run found (counts by kind from that job's findings),
 * with its time. A nightly refresh that found nothing is never shown, including ones stored before this rule.
 */
export async function getNotifications(pool: Pool, tenantId: string, userId: string): Promise<NotificationView[]> {
  return withTenant(pool, tenantId, async (client) => {
    await client.query("SELECT set_config('app.principal_id',$1,true)", [userId]);
    const result = await client.query<{ notification_id: string; notification_type: string; safe_summary: Record<string, unknown>; source_name: string | null; connector_type: string | null; connection_id: string | null; read_at: Date | null; created_at: Date; counts: NotificationCounts }>(
      `SELECT n.notification_id,n.notification_type,n.safe_summary,n.read_at,n.created_at,n.connection_id,
         coalesce(nullif(c.display_name,''),c.connector_type) AS source_name,c.connector_type,f.counts
       FROM core.notifications n LEFT JOIN registry.connections c ON c.tenant_id=n.tenant_id AND c.connection_id=n.connection_id
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'total',count(*),
           'tablesChanged',count(*) FILTER (WHERE kind='schema_change' AND detail->>'change'='columns'),
           'tablesDropped',count(*) FILTER (WHERE kind='schema_change' AND detail->>'change'='dropped'),
           'newTables',count(*) FILTER (WHERE kind='new_tables'),
           'newColumns',coalesce(sum(jsonb_array_length(detail->'added')) FILTER (WHERE kind='schema_change' AND detail->>'change'='columns'),0),
           'removedColumns',coalesce(sum(jsonb_array_length(detail->'removed')) FILTER (WHERE kind='schema_change' AND detail->>'change'='columns'),0),
           'retypedColumns',coalesce(sum(jsonb_array_length(detail->'retyped')) FILTER (WHERE kind='schema_change' AND detail->>'change'='columns'),0),
           'rowCountChanges',count(*) FILTER (WHERE kind='data_anomaly' AND detail->>'change'='row_count'),
           'countsUnavailable',count(*) FILTER (WHERE kind='data_anomaly' AND detail->>'change'='count_unavailable'),
           'sensitiveColumns',count(*) FILTER (WHERE kind='sensitive_column'),
           'probableRelationships',count(*) FILTER (WHERE kind='probable_relationship'),
           'idMatches',count(*) FILTER (WHERE kind='id_match')) AS counts
         FROM profiler.findings WHERE tenant_id=n.tenant_id AND job_id=n.job_id) f ON true
       WHERE n.tenant_id=$1 AND n.user_id=$2 AND NOT (n.notification_type='nightly' AND (f.counts->>'total')::int=0)
       ORDER BY n.created_at DESC`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({ notificationId: row.notification_id, type: row.notification_type, summary: { ...row.safe_summary, sourceName: row.source_name },
      readAt: row.read_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), connectionId: row.connection_id, sourceName: row.source_name, connectorType: row.connector_type,
      counts: Object.fromEntries(Object.entries(row.counts).map(([key, value]) => [key, Number(value)])) as NotificationCounts }));
  });
}

export async function markNotificationRead(pool: Pool, tenantId: string, userId: string, notificationId: string): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    await client.query("SELECT set_config('app.principal_id',$1,true)", [userId]);
    const result = await client.query(
      `UPDATE core.notifications SET read_at=COALESCE(read_at,clock_timestamp())
       WHERE tenant_id=$1 AND user_id=$2 AND notification_id=$3 RETURNING notification_id`,
      [tenantId, userId, notificationId],
    );
    return Boolean(result.rowCount);
  });
}

export async function storeWorkbook(
  pool: Pool,
  store: EncryptedArtifactStore,
  input: { tenantId: string; connectionId: string; bytes: Buffer },
): Promise<{ artifactId: string; encryptedSize: number }> {
  const connection = await withTenant(pool, input.tenantId, async (client) => client.query(
    `SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND connector_type='excel' AND status IN ('draft','active')`,
    [input.tenantId, input.connectionId],
  ));
  if (!connection.rowCount) throw new Error('excel_connection_not_found');
  const encrypted: StoredArtifact = await store.put(input.tenantId, input.bytes);
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO artifacts.workbooks(tenant_id,artifact_id,connection_id,opaque_file_id,content_sha256,key_salt,encrypted_size,key_version)
         VALUES($1,$2,$3,$2,$4,$5,$6,$7)`,
        [input.tenantId, encrypted.artifactId, input.connectionId, encrypted.contentSha256, encrypted.keySalt, encrypted.encryptedSize, encrypted.keyVersion],
      );
    });
  } catch (error) {
    await store.remove(input.tenantId, encrypted.artifactId);
    throw error;
  }
  return { artifactId: encrypted.artifactId, encryptedSize: encrypted.encryptedSize };
}

export async function readWorkbook(
  pool: Pool,
  store: EncryptedArtifactStore,
  input: { tenantId: string; connectionId: string; artifactId: string },
): Promise<Buffer> {
  const metadata = await withTenant(pool, input.tenantId, async (client) => client.query<{ key_salt: Buffer }>(
    `SELECT w.key_salt FROM artifacts.workbooks w JOIN registry.connections c
      ON c.tenant_id=w.tenant_id AND c.connection_id=w.connection_id
     WHERE w.tenant_id=$1 AND w.connection_id=$2 AND w.artifact_id=$3 AND c.status IN ('draft','active')`,
    [input.tenantId, input.connectionId, input.artifactId],
  ));
  const keySalt = metadata.rows[0]?.key_salt;
  if (!keySalt) throw new Error('workbook_not_found');
  return store.read(input.tenantId, input.artifactId, keySalt);
}

export async function retireConnection(
  pool: Pool,
  store: EncryptedArtifactStore | undefined,
  input: { tenantId: string; connectionId: string; principalId: string },
): Promise<void> {
  let artifactIds: string[] = [];
  await withTenant(pool, input.tenantId, async (client) => {
    const connection = await client.query<{ connector_agent_id: string | null; status: string }>(
      `SELECT connector_agent_id,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE`,
      [input.tenantId, input.connectionId],
    );
    const row = connection.rows[0];
    if (!row || row.status !== 'active') throw new Error('active_connection_not_found');
    const artifacts = await client.query<{ artifact_id: string }>(
      'SELECT artifact_id FROM artifacts.workbooks WHERE tenant_id=$1 AND connection_id=$2',
      [input.tenantId, input.connectionId],
    );
    artifactIds = artifacts.rows.map((artifact) => artifact.artifact_id);
    await client.query('DELETE FROM artifacts.workbooks WHERE tenant_id=$1 AND connection_id=$2', [input.tenantId, input.connectionId]);
    await client.query('DELETE FROM registry.connection_secrets WHERE tenant_id=$1 AND connection_id=$2', [input.tenantId, input.connectionId]);
    await client.query('DELETE FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2', [input.tenantId, input.connectionId]);
    await client.query("UPDATE graph.assets SET active=false,last_seen_at=clock_timestamp() WHERE tenant_id=$1 AND source_id=$2", [input.tenantId, input.connectionId]);
    await client.query(
      `UPDATE graph.assertions a SET review_status='stale'
       FROM graph.relationships r JOIN graph.assets source ON source.tenant_id=r.tenant_id AND source.asset_id IN (r.from_asset_id,r.to_asset_id)
       WHERE a.tenant_id=$1 AND a.relationship_id=r.relationship_id AND source.source_id=$2`,
      [input.tenantId, input.connectionId],
    );
    // An open profile job of a removed connection is cancelled; its worker loses the job at its next fenced write.
    await client.query("UPDATE profiler.jobs SET state='CANCELLED',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2 AND state IN ('QUEUED','RUNNING')", [input.tenantId, input.connectionId]);
    await client.query("UPDATE registry.connections SET status='retired' WHERE tenant_id=$1 AND connection_id=$2", [input.tenantId, input.connectionId]);
    if (row.connector_agent_id) {
      await client.query("UPDATE registry.agents SET status='retired' WHERE tenant_id=$1 AND agent_id=$2", [input.tenantId, row.connector_agent_id]);
      await client.query(
        `INSERT INTO registry.events(tenant_id,event_type,agent_id,connection_id,safe_payload)
         VALUES($1,'agent_retired',$2,$3,'{}'::jsonb)`,
        [input.tenantId, row.connector_agent_id, input.connectionId],
      );
    }
    await client.query(
      `INSERT INTO core.activity_events(tenant_id,event_type,principal_id,connector_id)
       VALUES($1,'connector_retired',$2,$3)`,
      [input.tenantId, input.principalId, input.connectionId],
    );
  });
  if (store) await Promise.all(artifactIds.map((artifactId) => store.remove(input.tenantId, artifactId)));
}

export { runIdAgent, formatPattern, ID_FINGERPRINT_LIMIT } from './id-agent.js';
export { DESCRIPTION_LIMITS, descriptionBatches, descriptionSubjects, describeInput, describeRequest, draftModelDescriptions, inputHash, validDraft, type DescribeCall, type DescribeRequest, type DescriptionSubject } from './descriptions.js';
export { isObjectError, sourceErrorCode } from './source-errors.js';
export { COPY_SIMILARITY, detectCopies, normaliseRoutine, routineSimilarity } from './copies.js';
export { queueProfileJob, type ProfileJobType } from './discovery-jobs.js';
export { claimDiscovery, finishDiscovery, latestDiscovery, queueDiscovery, StaleDiscoveryJobError, DISCOVERY_LEASE_MS, type DiscoveryJob } from './discovery-jobs.js';
export { readProfileState, recordFindings, listFindings, decideFinding, ROW_CHANGE_SHARE, type FindingRow } from './findings.js';
export { claimDueNightly, queueDueNightly } from './nightly.js';
export { connectorForConnection } from './connector-for.js';

export { getControls, saveControls, listControlChanges, decideControlChange } from './controls.js';

/**
 * Claims and runs one queued discovery job (decision 57). Returns false when nothing is queued. A failure is recorded on
 * the job by code: FAILED before anything was written, PARTIAL when the profile was stored but relationships, lineage
 * or findings could not be mapped. A job this worker no longer holds is left to its new owner.
 */
export async function runNextDiscovery(pool: Pool, connectorFor: (tenantId: string, connectionId: string) => Promise<ReadOnlyConnector>, onlyTenant?: string, leaseMs?: number,
  /** Runs after a profile has been stored (decision 67: description drafting). It can never fail the profile. */
  afterProfile?: (tenantId: string, connectionId: string) => Promise<void>): Promise<boolean> {
  const job = await claimDiscovery(pool, leaseMs, onlyTenant);
  if (!job) return false;
  let connector: ReadOnlyConnector | undefined;
  // The lease is renewed for the whole job, through relationships, lineage, the ID agent and findings, which can take
  // minutes on a large source; otherwise another worker could reclaim a job that is still running.
  const beat = heartbeat(pool, job, leaseMs);
  try {
    connector = await connectorFor(job.tenantId, job.connectionId);
    await runProfile(pool, { tenantId: job.tenantId, connectionId: job.connectionId, connector, jobType: job.jobType ?? 'discovery', job, beat });
    if (afterProfile) {
      try { await afterProfile(job.tenantId, job.connectionId); }
      catch (error) { console.error(`After-profile step failed for connection ${job.connectionId}: ${error instanceof Error && /^[\w:-]{1,80}$/.test(error.message) ? error.message : 'after_profile_failed'}`); }
    }
  } catch (error) {
    if (error instanceof StaleDiscoveryJobError) return true;
    const code = sourceErrorCode(error);
    const stored = await withTenant(pool, job.tenantId, (client) => client.query<{ phase: string | null }>('SELECT phase FROM profiler.jobs WHERE tenant_id=$1 AND job_id=$2', [job.tenantId, job.jobId]));
    await finishDiscovery(pool, job, { state: stored.rows[0]?.phase === 'relationships' ? 'PARTIAL' : 'FAILED', failureCode: code });
    // The reason code and connection only: driver messages can carry host or user names.
    console.error(`Profile (${job.jobType ?? 'discovery'}) failed for connection ${job.connectionId} (tenant ${job.tenantId}): ${code}`);
  } finally { beat.stop(); await connector?.close?.(); }
  return true;
}

async function notifyUsers(client: PoolClient, tenantId: string, connectionId: string, jobId: string, type: 'discovery' | 'nightly', summary: Record<string, number>): Promise<void> {
  const users = await client.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND is_active=true', [tenantId]);
  for (const user of users.rows) {
    await client.query("SELECT set_config('app.principal_id',$1,true)", [user.user_id]);
    await client.query(
      `INSERT INTO core.notifications(tenant_id,user_id,connection_id,job_id,notification_type,safe_summary)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,user_id,job_id,notification_type) DO NOTHING`,
      [tenantId, user.user_id, connectionId, jobId, type, JSON.stringify(summary)]);
  }
}

/**
 * Decision 62: each object's owner and creation order, and which procedures and functions are near-identical copies of
 * another (the later-created one), so the Dictionary can tell customer-built objects from vendor-delivered ones.
 * Auxiliary: a failure is logged by code and leaves the previous record, never failing the profile.
 */
export async function recordObjectOrigins(pool: Pool, input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector }): Promise<{ objects: number; copies: number } | undefined> {
  if (!input.connector.objectOrigins) return undefined;
  try {
    const origins = await input.connector.objectOrigins();
    return await withTenant(pool, input.tenantId, async (client) => {
      const order = new Map(origins.map((origin) => [origin.qualifiedName, origin.createdOrder]));
      const routines = (await client.query<{ qualified_name: string; scrubbed_text: string }>(
        "SELECT qualified_name,scrubbed_text FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active AND kind IN ('procedure','function') AND scrubbed_text IS NOT NULL",
        [input.tenantId, input.connectionId])).rows;
      const copies = detectCopies(routines.map((row) => ({ qualifiedName: row.qualified_name, text: row.scrubbed_text, createdOrder: order.get(row.qualified_name) ?? null })));
      await client.query('DELETE FROM graph.object_origins WHERE tenant_id=$1 AND source_id=$2', [input.tenantId, input.connectionId]);
      for (let start = 0; start < origins.length; start += 5_000) {
        const batch = origins.slice(start, start + 5_000);
        await client.query(
          `INSERT INTO graph.object_origins(tenant_id,source_id,qualified_name,owner,created_order,copy_of,copy_similarity)
           SELECT $1,$2,n,o,c,cp,cs FROM unnest($3::text[],$4::text[],$5::bigint[],$6::text[],$7::numeric[]) AS u(n,o,c,cp,cs) ON CONFLICT DO NOTHING`,
          [input.tenantId, input.connectionId, batch.map((item) => item.qualifiedName), batch.map((item) => item.owner), batch.map((item) => item.createdOrder),
            batch.map((item) => copies.get(item.qualifiedName)?.copyOf ?? null), batch.map((item) => copies.get(item.qualifiedName)?.similarity ?? null)]);
      }
      return { objects: origins.length, copies: copies.size };
    });
  } catch (error) {
    console.error(`Object origins not recorded for connection ${input.connectionId}: ${sourceErrorCode(error)}`);
    return undefined;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { EncryptedArtifactStore, type StoredArtifact } from '@scaleinsyght/artifacts';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector, ScopeMode } from '@scaleinsyght/connectors';
import { listGoldenStructuralReferences } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';

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

function scopeForConnector(rules: ScopeRule[]): ConnectorScope | undefined {
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function runGoldenProfile(
  pool: Pool,
  input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector; jobType: 'discovery' | 'profile' | 'nightly' },
): Promise<ProfileSummary> {
  const started = performance.now();
  const rules = await readConnectionScope(pool, input.tenantId, input.connectionId);
  const scope = scopeForConnector(rules);
  const mode = input.jobType === 'nightly' ? 'nightly' : 'profile';
  const discovery: DiscoveryResult = await input.connector.discover(scope ? { mode, scope } : { mode });
  const profiles: Array<{ object: DiscoveryResult['objects'][number]; profile: ObjectProfile }> = [];
  for (const object of discovery.objects) {
    profiles.push({ object, profile: await input.connector.profile(object.assetKey, scope, mode) });
  }
  const jobId = randomUUID();
  let createdVersions = 0;

  await withTenant(pool, input.tenantId, async (client) => {
    await client.query(
      `INSERT INTO profiler.jobs(tenant_id,job_id,connection_id,job_type,state)
       VALUES($1,$2,$3,$4,'RUNNING')`,
      [input.tenantId, jobId, input.connectionId, input.jobType],
    );
    await client.query(
      `INSERT INTO profiler.events(tenant_id,job_id,sequence,event_type,safe_payload)
       VALUES($1,$2,1,'profile_started',$3::jsonb)`,
      [input.tenantId, jobId, JSON.stringify({ connector_type: input.connector.type, job_type: input.jobType })],
    );

    const objectStates = [
      ...discovery.objects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'COMPLETED' as const, assetKey: object.assetKey })),
      ...discovery.unchangedObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'SKIPPED' as const, assetKey: object.assetKey })),
      ...discovery.listOnlyObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'list_only' as const, state: 'SKIPPED' as const, assetKey: null })),
      ...discovery.excludedObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'exclude' as const, state: 'SKIPPED' as const, assetKey: null })),
      ...discovery.inaccessibleObjects.map((object) => ({ name: object.qualifiedName, type: object.type, mode: 'profile' as const, state: 'INACCESSIBLE' as const, assetKey: null })),
    ];

    const tableAssets = new Map<string, string>();
    const fieldAssets = new Map<string, string>();
    for (const { object, profile } of profiles) {
      const datasetId = await ensureAsset(client, input.tenantId, input.connectionId, object.assetKey, 'dataset', object.qualifiedName);
      tableAssets.set(object.qualifiedName, datasetId);
      const structural = { object_type: object.type, columns: profile.columns.map(({ name, dataType, isNullable }) => ({ name, data_type: dataType, nullable: isNullable })) };
      const statistics = { row_count: profile.rowCount };
      const version = await ensureAssetVersion(client, input.tenantId, datasetId, structural, statistics);
      if (version.created) createdVersions += 1;
      for (const column of profile.columns) {
        const fieldName = `${object.qualifiedName}.${column.name}`;
        const fieldFingerprint = createHash('sha256').update(`${input.connectionId}\0${fieldName}`).digest();
        const fieldAssetId = await ensureAsset(client, input.tenantId, input.connectionId, fieldFingerprint, 'field', fieldName);
        fieldAssets.set(fieldName, fieldAssetId);
        const fieldStructural = { object_type: 'field', data_type: column.dataType, nullable: column.isNullable };
        const fieldVersion = await ensureAssetVersion(client, input.tenantId, fieldAssetId, fieldStructural, {});
        if (fieldVersion.created) createdVersions += 1;
        await client.query(
          `INSERT INTO profiler.field_profiles(tenant_id,asset_id,profile_version,field_name,data_type,is_nullable,sensitivity_tags,null_rate,distinct_count)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(tenant_id,asset_id,profile_version,field_name) DO NOTHING`,
          [input.tenantId, fieldAssetId, fieldVersion.version, column.name, column.dataType, column.isNullable,
            column.sensitivityTags, column.statistics.nullRate, column.statistics.distinctCount],
        );
        await client.query(
          `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity)
           VALUES($1,'structural','CONTAINS',$2,$3,'field')
           ON CONFLICT DO NOTHING`,
          [input.tenantId, datasetId, fieldAssetId],
        );
      }
    }

    for (const reference of listGoldenStructuralReferences()) {
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
      const existingAssertion = await client.query(
        `SELECT 1 FROM graph.assertions WHERE tenant_id=$1 AND relationship_id=$2 AND evidence_method='declared' LIMIT 1`,
        [input.tenantId, relationship.rows[0]!.relationship_id],
      );
      if (!existingAssertion.rowCount) {
        const evidence = await client.query<{ evidence_id: string }>(
          `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata)
           VALUES($1,'declared_foreign_key','{"collector":"golden_schema","source":"synthetic"}'::jsonb)
           RETURNING evidence_id`,
          [input.tenantId],
        );
        await client.query(
          `INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,collector_version)
           VALUES($1,$2,'declared',$3,1,'Synthetic declared key metadata','phase1-golden-v1')`,
          [input.tenantId, relationship.rows[0]!.relationship_id, [evidence.rows[0]!.evidence_id]],
        );
      }
    }

    const inventoryNames=new Set(objectStates.map((object)=>object.name));
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
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
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
    };
    await client.query(
      `UPDATE profiler.jobs SET state='COMPLETED',state_version=state_version+1,listed_count=$3,profiled_count=$4,inaccessible_count=$5,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND job_id=$2`,
      [input.tenantId, jobId, summary.listed, summary.profiled, summary.inaccessible],
    );
    await client.query(
      `INSERT INTO profiler.events(tenant_id,job_id,sequence,event_type,safe_payload)
       VALUES($1,$2,2,$3,$4::jsonb)`,
      [input.tenantId, jobId, input.jobType === 'nightly' ? 'schema_changed' : 'profile_completed', JSON.stringify(summary)],
    );

    const users = await client.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND is_active=true', [input.tenantId]);
    for (const user of users.rows) {
      await client.query("SELECT set_config('app.principal_id',$1,true)", [user.user_id]);
      await client.query(
        `INSERT INTO core.notifications(tenant_id,user_id,connection_id,job_id,notification_type,safe_summary)
         VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,user_id,job_id,notification_type) DO NOTHING`,
        [input.tenantId, user.user_id, input.connectionId, jobId, input.jobType === 'nightly' ? 'nightly' : 'discovery', JSON.stringify(summary)],
      );
    }
  });

  return {
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

export async function getNotifications(pool: Pool, tenantId: string, userId: string): Promise<Array<{ notificationId: string; type: string; summary: Record<string, unknown>; readAt: string | null }>> {
  return withTenant(pool, tenantId, async (client) => {
    await client.query("SELECT set_config('app.principal_id',$1,true)", [userId]);
    const result = await client.query<{ notification_id: string; notification_type: string; safe_summary: Record<string, unknown>; read_at: Date | null }>(
      `SELECT notification_id,notification_type,safe_summary,read_at FROM core.notifications
       WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({ notificationId: row.notification_id, type: row.notification_type, summary: row.safe_summary, readAt: row.read_at?.toISOString() ?? null }));
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
    `SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND connector_type='excel' AND status='active'`,
    [input.tenantId, input.connectionId],
  ));
  if (!connection.rowCount) throw new Error('active_excel_connection_not_found');
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
     WHERE w.tenant_id=$1 AND w.connection_id=$2 AND w.artifact_id=$3 AND c.status='active'`,
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

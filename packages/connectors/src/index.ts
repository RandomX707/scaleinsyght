import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export { getGoldenMetadataFixture, getGoldenPhase3Dataset } from './metadata.js';
export { createLakeConnector, createCrmConnector } from './generic.js';

export type SourceConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'lake' | 'crm';
export type AssetType = 'table' | 'view';
export type ScopeMode = 'profile' | 'list_only' | 'exclude';

interface GoldenSource {
  id: string;
  type: SourceConnectorType;
  name: string;
  tableCount: number;
  inaccessible: string[];
  sheets?: string[];
  nightlyChanges?: string[];
}

interface GoldenDataset {
  sources: GoldenSource[];
  objectNameTemplate: string;
  changedOnNightly: string[];
  structuralReferences: Array<{ from: string; to: string; fromColumn: string; toColumn: string }>;
}

export interface DiscoveredObject {
  assetKey: string;
  qualifiedName: string;
  type: AssetType;
  scopeMode: ScopeMode;
}

export interface DiscoveryResult {
  objects: DiscoveredObject[];
  listOnlyObjects: Array<{ qualifiedName: string; type: AssetType }>;
  excludedObjects: Array<{ qualifiedName: string; type: AssetType }>;
  inaccessibleObjects: Array<{ qualifiedName: string; type: AssetType }>;
  coverage: { listed: number; accessible: number; inaccessible: number };
  unchanged: number;
  unchangedObjects: DiscoveredObject[];
}

export interface ObjectProfile {
  assetKey: string;
  qualifiedName: string;
  version: string;
  columns: Array<{
    name: string;
    dataType: string;
    isNullable: boolean;
    sensitivityTags: string[];
    statistics: { nullRate: number | null; distinctCount: number | null };
  }>;
  rowCount: number;
}

export interface ConnectorScope {
  profile?: string[];
  listOnly?: string[];
  exclude?: string[];
}

export interface ReadOnlyConnector {
  readonly id: string;
  readonly type: SourceConnectorType;
  readonly name: string;
  readonly modelRequests: number;
  test(): Promise<{ ok: true; capabilities: ['discover', 'profile']; readOnly: true }>;
  discover(input: { mode: 'profile' | 'nightly'; scope?: ConnectorScope }): Promise<DiscoveryResult>;
  profile(assetKey: string, scope?: ConnectorScope, mode?: 'profile' | 'nightly'): Promise<ObjectProfile>;
  queryAggregate?(assetKey: string, metric: 'count'): Promise<{ metric: 'count'; value: number }>;
  structuralReferences?(): Promise<Array<{from:string;to:string;fromColumn:string;toColumn:string}>>;
  close?(): Promise<void>;
}

const fixturePath = fileURLToPath(new URL('../../../tests/golden/phase1.json', import.meta.url));
const golden = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenDataset;
const systemObjects = ['pg_catalog.pg_class', 'information_schema.tables'];

function keyFor(sourceId: string, qualifiedName: string): string {
  return createHash('sha256').update(`${sourceId}\0${qualifiedName}`).digest('hex');
}

function sourceObjects(source: GoldenSource): Array<{ qualifiedName: string; type: AssetType }> {
  if (source.sheets) {
    return source.sheets.map((sheet) => ({ qualifiedName: `${source.name}.${sheet}`, type: 'table' }));
  }
  const objects = Array.from({ length: source.tableCount }, (_, index) => ({
    qualifiedName: golden.objectNameTemplate.replace('{index}', String(index + 1).padStart(3, '0')),
    type: 'table' as const,
  }));
  source.inaccessible.forEach((qualifiedName, index) => {
    const target = objects.length - index - 1;
    if (target >= 0) objects[target] = { qualifiedName, type: 'table' };
  });
  return objects;
}

class GoldenConnector implements ReadOnlyConnector {
  readonly id: string;
  readonly type: SourceConnectorType;
  readonly name: string;
  readonly modelRequests = 0;
  private readonly objects: Array<{ qualifiedName: string; type: AssetType }>;
  private readonly inaccessible: Set<string>;
  private readonly nightlyChanges: Set<string>;

  constructor(source: GoldenSource) {
    this.id = source.id;
    this.type = source.type;
    this.name = source.name;
    this.objects = sourceObjects(source);
    this.inaccessible = new Set(source.inaccessible);
    this.nightlyChanges = new Set(source.nightlyChanges ?? golden.changedOnNightly);
  }

  async test(): Promise<{ ok: true; capabilities: ['discover', 'profile']; readOnly: true }> {
    return { ok: true, capabilities: ['discover', 'profile'], readOnly: true };
  }

  async discover(input: { mode: 'profile' | 'nightly'; scope?: ConnectorScope }): Promise<DiscoveryResult> {
    const profileScope = new Set(input.scope?.profile ?? []);
    const listOnlyScope = new Set(input.scope?.listOnly ?? []);
    const excludedScope = new Set(input.scope?.exclude ?? []);
    const changed = this.nightlyChanges;
    const result: DiscoveryResult = {
      objects: [],
      listOnlyObjects: [],
      excludedObjects: [],
      inaccessibleObjects: [],
      coverage: { listed: 0, accessible: 0, inaccessible: 0 },
      unchanged: 0,
      unchangedObjects: [],
    };

    for (const object of this.objects) {
      if (systemObjects.includes(object.qualifiedName)) continue;
      result.coverage.listed += 1;
      if (this.inaccessible.has(object.qualifiedName)) {
        result.inaccessibleObjects.push(object);
        result.coverage.inaccessible += 1;
        continue;
      }
      result.coverage.accessible += 1;

      if (excludedScope.has(object.qualifiedName)) {
        result.excludedObjects.push(object);
        continue;
      }
      if (listOnlyScope.has(object.qualifiedName)) {
        result.listOnlyObjects.push(object);
        continue;
      }
      if (profileScope.size && !profileScope.has(object.qualifiedName)) {
        result.excludedObjects.push(object);
        continue;
      }
      if (input.mode === 'nightly' && !changed.has(object.qualifiedName)) {
        result.unchanged += 1;
        result.unchangedObjects.push({ ...object, assetKey: keyFor(this.id, object.qualifiedName), scopeMode: 'profile' });
        continue;
      }
      result.objects.push({ ...object, assetKey: keyFor(this.id, object.qualifiedName), scopeMode: 'profile' });
    }
    return result;
  }

  async profile(assetKey: string, scope?: ConnectorScope, mode: 'profile' | 'nightly' = 'profile'): Promise<ObjectProfile> {
    const object = this.objects.find((candidate) => keyFor(this.id, candidate.qualifiedName) === assetKey);
    if (!object) throw new Error('asset_not_found');
    if (this.inaccessible.has(object.qualifiedName)) throw new Error('object_inaccessible');
    if (scope?.exclude?.includes(object.qualifiedName) || scope?.listOnly?.includes(object.qualifiedName)) {
      throw new Error('object_out_of_scope');
    }
    if (scope?.profile?.length && !scope.profile.includes(object.qualifiedName)) throw new Error('object_out_of_scope');
    const columns = [
      { name: 'record_id', dataType: 'text', isNullable: false, sensitivityTags: ['identifier'], statistics: { nullRate: null, distinctCount: null } },
      { name: 'display_name', dataType: 'text', isNullable: true, sensitivityTags: [], statistics: { nullRate: 0.03, distinctCount: 87 } },
      { name: 'created_at', dataType: 'timestamp', isNullable: false, sensitivityTags: [], statistics: { nullRate: 0, distinctCount: 500 } },
    ];
    if (mode === 'nightly' && this.nightlyChanges.has(object.qualifiedName)) {
      columns.push({ name: 'new_metric', dataType: 'numeric', isNullable: true, sensitivityTags: [], statistics: { nullRate: 0.01, distinctCount: 220 } });
    }
    const version = createHash('sha256').update(JSON.stringify({ object, columns, rowCount: 500 })).digest('hex');
    return { assetKey, qualifiedName: object.qualifiedName, version, columns, rowCount: 500 };
  }
}

export function createGoldenConnector(sourceId: string): ReadOnlyConnector {
  const source = golden.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`golden_source_not_found:${sourceId}`);
  return new GoldenConnector(source);
}

export { PostgresConnector, createPostgresConnector, type PostgresStructuralReference } from './postgres.js';
export { encryptConnectionSecret, decryptConnectionSecret, type EncryptedConnectionSecret } from './connection-secrets.js';

export function listGoldenSources(): ReadonlyArray<Pick<GoldenSource, 'id' | 'type' | 'name'>> {
  return golden.sources.map(({ id, type, name }) => ({ id, type, name }));
}

export function listGoldenStructuralReferences(): ReadonlyArray<GoldenDataset['structuralReferences'][number]> {
  return golden.structuralReferences;
}

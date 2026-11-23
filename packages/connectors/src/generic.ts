import { createHash } from 'node:crypto';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector, SourceConnectorType } from './index.js';

type MetadataAsset = { name: string; kind: 'table' | 'view'; columns: Array<{ name: string; type: string; nullable: boolean }> };
const definitions: Record<'lake' | 'crm', MetadataAsset[]> = {
  lake: [
    { name: 'lake.encounters', kind: 'table', columns: [{ name: 'encounter_key', type: 'string', nullable: false }, { name: 'department_key', type: 'string', nullable: false }, { name: 'occurred_at', type: 'timestamp', nullable: false }] },
    { name: 'lake.departments', kind: 'table', columns: [{ name: 'department_key', type: 'string', nullable: false }, { name: 'department_name', type: 'string', nullable: false }] },
  ],
  crm: [
    { name: 'crm.accounts', kind: 'table', columns: [{ name: 'account_key', type: 'string', nullable: false }, { name: 'region', type: 'string', nullable: true }] },
    { name: 'crm.cases', kind: 'view', columns: [{ name: 'case_key', type: 'string', nullable: false }, { name: 'account_key', type: 'string', nullable: false }, { name: 'opened_at', type: 'timestamp', nullable: false }] },
  ],
};

class GenericReadOnlyConnector implements ReadOnlyConnector {
  readonly modelRequests = 0;
  readonly id: string;
  readonly type: SourceConnectorType;
  readonly name: string;
  private readonly assets: MetadataAsset[];
  constructor(type: 'lake' | 'crm', id: string, name: string) { this.type = type; this.id = id; this.name = name; this.assets = definitions[type]; }
  async test() { return { ok: true as const, capabilities: ['discover', 'profile'] as ['discover', 'profile'], readOnly: true as const }; }
  async discover(input: { mode: 'profile' | 'nightly'; scope?: ConnectorScope }): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { objects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: this.assets.length, accessible: this.assets.length, inaccessible: 0 }, unchanged: 0, unchangedObjects: [] };
    for (const asset of this.assets) {
      const type = asset.kind;
      const object = { assetKey: this.key(asset.name), qualifiedName: asset.name, type, scopeMode: 'profile' as const };
      if (input.scope?.exclude?.includes(asset.name) || (input.scope?.profile?.length && !input.scope.profile.includes(asset.name))) result.excludedObjects.push({ qualifiedName: asset.name, type });
      else if (input.scope?.listOnly?.includes(asset.name)) result.listOnlyObjects.push({ qualifiedName: asset.name, type });
      else result.objects.push(object);
    }
    return result;
  }
  async profile(assetKey: string, scope?: ConnectorScope): Promise<ObjectProfile> {
    const asset = this.assets.find((candidate) => this.key(candidate.name) === assetKey);
    if (!asset) throw new Error('asset_not_found');
    if (scope?.exclude?.includes(asset.name) || scope?.listOnly?.includes(asset.name) || (scope?.profile?.length && !scope.profile.includes(asset.name))) throw new Error('object_out_of_scope');
    const columns = asset.columns.map((column) => ({ name: column.name, dataType: column.type, isNullable: column.nullable, sensitivityTags: column.name.endsWith('_key') ? ['identifier'] : [], statistics: { nullRate: null, distinctCount: null } }));
    return { assetKey, qualifiedName: asset.name, version: this.key(JSON.stringify(asset)), rowCount: 0, columns };
  }
  async queryAggregate(assetKey: string, metric: 'count'): Promise<{ metric: 'count'; value: number }> {
    if (metric !== 'count' || !this.assets.some((asset) => this.key(asset.name) === assetKey)) throw new Error('connector_query_not_supported');
    return { metric: 'count', value: 1250 + (this.assets.findIndex((asset) => this.key(asset.name) === assetKey) * 375) };
  }
  private key(value: string) { return createHash('sha256').update(`${this.type}\0${value}`).digest('hex'); }
}

export function createLakeConnector(id = 'synthetic-lake', name = 'Synthetic lake'): ReadOnlyConnector { return new GenericReadOnlyConnector('lake', id, name); }
export function createCrmConnector(id = 'synthetic-crm', name = 'Synthetic CRM'): ReadOnlyConnector { return new GenericReadOnlyConnector('crm', id, name); }

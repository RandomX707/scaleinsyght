export type SourceConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'lake' | 'crm';
export type AssetType = 'table' | 'view';
export type ScopeMode = 'profile' | 'list_only' | 'exclude';

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

export { PostgresConnector, createPostgresConnector, type PostgresStructuralReference } from './postgres.js';
export { encryptConnectionSecret, decryptConnectionSecret, type EncryptedConnectionSecret } from './connection-secrets.js';

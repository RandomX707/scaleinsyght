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
    /** Original column text when it differs from the SQL identifier (for example a workbook header). */
    label?: string;
    dataType: string;
    isNullable: boolean;
    sensitivityTags: string[];
    /** Why each tag applies: declared by the source or inferred by the detector (decision 41). */
    sensitivityEvidence?: Array<{ tag: string; detection: 'declared' | 'inferred'; reason: string }>;
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
  structuralReferences?(): Promise<Array<{from:string;to:string;fromColumn:string;toColumn:string;evidenceMethod?:'declared'|'inferred';confidence?:number;matchedCount?:number;sourceCount?:number}>>;
  routines?():Promise<Array<{qualifiedName:string;kind:'function'|'procedure';definition:string}>>;
  executeQueryIntent?(intent:unknown,includeCellSize?:boolean):Promise<{sql:string;rows:Array<Record<string,unknown>>}>;
  /** Original text of a column (for example a workbook header) when it differs from its SQL identifier. */
  columnLabels?(table:string):Promise<Record<string,string>>;
  close?(): Promise<void>;
}

export { PostgresConnector, createPostgresConnector, type PostgresStructuralReference } from './postgres.js';
export { SqlServerConnector, createSqlServerConnector, type SqlServerConnection } from './sql-server.js';
export { encryptConnectionSecret, decryptConnectionSecret, type EncryptedConnectionSecret } from './connection-secrets.js';
export { ExcelConnector, createExcelConnector, parseWorkbook, normaliseIdentifier, type WorkbookSheet, type WorkbookColumn } from './excel.js';

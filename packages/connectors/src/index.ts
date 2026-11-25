export type SourceConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'lake' | 'crm';
export type AssetType = 'table' | 'view';
export type ScopeMode = 'profile' | 'list_only' | 'exclude';

export interface DiscoveredObject {
  assetKey: string;
  qualifiedName: string;
  type: AssetType;
  scopeMode: ScopeMode;
}

export type Routine = {qualifiedName:string;kind:'function'|'procedure';definition:string|null;encrypted:boolean;parameters:Array<{name:string;dataType:string;mode:'in'|'out'|'inout'}>};

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
    /** Measured on untagged columns only; tagged columns and unsupported types keep null (contract 7). averageLength is for text. */
    statistics: ColumnStatistics;
  }>;
  rowCount: number | null;
}

export type ColumnStatistics = { nullRate: number | null; distinctCount: number | null; averageLength?: number | null };
/** Tables above this row count are profiled for structure and row count only; their column statistics stay unmeasured. */
export const COLUMN_STATISTICS_ROW_LIMIT = 10_000_000;
export const UNMEASURED: ColumnStatistics = { nullRate: null, distinctCount: null, averageLength: null };

/** Inferred references: at least this share of non-null values must match a unique target key to be proposed as a
 * relationship that plans may join on (decision 38). */
export const PROPOSED_REFERENCE_COVERAGE = 0.98;
/** Lower-coverage candidates down to this share are kept as possible relationships, shown only on request and labelled
 * low confidence; plans never join on them (decision 38). */
export const POSSIBLE_REFERENCE_COVERAGE = 0.5;

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
  /** Procedures and functions: definition text as the source returns it (null when withheld), whether the source
   *  encrypts it, and the declared parameters. Callers scrub the text before storing it (decision 53). */
  routines?():Promise<Routine[]>;
  /** View definitions for SQL lineage parsing. definition is null when the source hides it (for example an encrypted module). */
  viewDefinitions?():Promise<Array<{qualifiedName:string;schema:string;definition:string|null}>>;
  /** Distinct non-null values of one column, as text, for keyed fingerprinting by the ID agent. Values stay in memory:
   * they are fingerprinted and discarded, never stored, logged or sent to a model (non-negotiable 6). Returns null
   * when the column has more than limit distinct values. */
  distinctValues?(qualifiedName:string,column:string,limit:number):Promise<string[]|null>;
  executeQueryIntent?(intent:unknown,includeCellSize?:boolean):Promise<{sql:string;rows:Array<Record<string,unknown>>}>;
  /** Original text of a column (for example a workbook header) when it differs from its SQL identifier. */
  categoryValues?(table: string, column: string): Promise<{sql: string; values: string[]} | undefined>;
  columnLabels?(table:string):Promise<Record<string,string>>;
  close?(): Promise<void>;
}

export { PostgresConnector, createPostgresConnector, type PostgresStructuralReference } from './postgres.js';
export { SqlServerConnector, createSqlServerConnector, type SqlServerConnection } from './sql-server.js';
export { encryptConnectionSecret, decryptConnectionSecret, type EncryptedConnectionSecret } from './connection-secrets.js';
export { ExcelConnector, createExcelConnector, parseWorkbook, normaliseIdentifier, type WorkbookSheet, type WorkbookColumn } from './excel.js';

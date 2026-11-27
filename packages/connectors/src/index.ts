export { connectionConnectTimeout, connectionQueryTimeout } from './limits.js';
import type { ControlsPolicy } from './scope.js';
export { objectScope, columnScope, type ControlsPolicy } from './scope.js';
export type SourceConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'lake' | 'crm';
export type AssetType = 'table' | 'view';
export type ScopeMode = 'profile' | 'list_only' | 'exclude';

export interface DiscoveredObject {
  assetKey: string;
  qualifiedName: string;
  type: AssetType;
  scopeMode: ScopeMode;
}

/** createdOrder only orders objects within one source (PostgreSQL object id; SQL Server creation time in seconds). */
export type ObjectOrigin = {qualifiedName:string;owner:string|null;createdOrder:number|null};
/** parameters are what a caller passes (and, for a procedure, gets back through OUT parameters); returns are the columns a
 *  function returns as a table (PostgreSQL RETURNS TABLE or OUT arguments, SQL Server table-valued functions). Decision 64. */
export type Routine = {qualifiedName:string;kind:'function'|'procedure';definition:string|null;encrypted:boolean;parameters:Array<{name:string;dataType:string;mode:'in'|'out'|'inout'}>;returns?:Array<{name:string;dataType:string}>};

export interface DiscoveryResult {
  objects: DiscoveredObject[];
  listOnlyObjects: Array<{ qualifiedName: string; type: AssetType }>;
  excludedObjects: Array<{ qualifiedName: string; type: AssetType }>;
  inaccessibleObjects: Array<{ qualifiedName: string; type: AssetType }>;
  coverage: { listed: number; accessible: number; inaccessible: number };
  unchanged: number;
  unchangedObjects: DiscoveredObject[];
  timedOutObjects?: ReadonlySet<string>;
}

export interface ObjectProfile {
  assetKey: string;
  qualifiedName: string;
  version: string;
  /** Set when the source ran out of time on this object: columns and row count are known, samples and statistics are not. */
  limited?: 'timeout';
  /** The row count is the database's catalog estimate, not an exact count (decision 59). */
  rowCountEstimated?: boolean;
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

/** estimated: from a sample or the database's catalog statistics, not a full scan (decision 59). */
export type ColumnStatistics = { nullRate: number | null; distinctCount: number | null; averageLength?: number | null; estimated?: boolean };
export { ID_SAMPLE_MINIMUM_DISTINCT, ID_SAMPLE_MODULUS, inIdSample, postgresIdSampleCondition, sqlServerIdSampleCondition } from './id-sample.js';
/** Large tables are sampled rather than skipped (decision 59, ./sampling.ts). */
export { EXACT_COUNT_LIMIT, STATISTICS_SAMPLE_ROWS, SENSITIVITY_SAMPLE_ROWS, samplePercent, catalogEstimate, distinctFromCatalog } from './sampling.js';
export const UNMEASURED: ColumnStatistics = { nullRate: null, distinctCount: null, averageLength: null };

/** Inferred references: at least this share of non-null values must match a unique target key to be proposed as a
 * relationship that plans may join on (decision 38). */
export const PROPOSED_REFERENCE_COVERAGE = 0.98;
/** Lower-coverage candidates down to this share are kept as possible relationships, shown only on request and labelled
 * low confidence; plans never join on them (decision 38). */
export const POSSIBLE_REFERENCE_COVERAGE = 0.5;
/** Decision 63: an inferred reference is checked on at most this many non-null source values, each looked up in the
 *  target's primary key, never by joining whole tables (a full join on test_emr exceeded the source's time limit). */
export const REFERENCE_CHECK_SAMPLE = 10_000;
export type SkippedReference = { from: string; to: string; fromColumn: string; toColumn: string };

export function withSkippedChecks<T>(references: T[], skippedChecks: number, timedOutChecks: SkippedReference[]) {
  return Object.defineProperties(references, {
    skippedChecks: { value: skippedChecks },
    timedOutChecks: { value: timedOutChecks },
  }) as T[] & { skippedChecks: number; timedOutChecks: SkippedReference[] };
}

export function isSourceQueryTimeout(error: unknown): boolean {
  const failure = error as { message?: string; code?: string; originalError?: { code?: string } } | null;
  return failure?.message === 'source_query_timeout'
    || ['SOURCE_QUERY_TIMEOUT', '57014', 'ETIMEOUT'].includes(failure?.code ?? failure?.originalError?.code ?? '');
}

/** A reference check that times out, or whose table can no longer be read, skips that candidate only (decision 63). */
export function isSkippableCheckError(error: unknown): boolean {
  const failure = error as { code?: unknown; number?: unknown; originalError?: { code?: unknown; number?: unknown } } | null;
  const code = String(failure?.code ?? failure?.originalError?.code ?? ''); const number = Number(failure?.number ?? failure?.originalError?.number ?? 0);
  return isSourceQueryTimeout(error) || ['42501', '42P01'].includes(code) || [208, 229].includes(number);
}

export interface ConnectorScope {
  profile?: string[];
  listOnly?: string[];
  exclude?: string[];
  policy?: ControlsPolicy;
  knownObjects?: ReadonlySet<string>;
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
  /** Declared and inferred references. `sampled` marks a check made on the first REFERENCE_CHECK_SAMPLE values;
   *  `skippedChecks` on the result counts candidates whose check timed out (decision 63). */
  structuralReferences?(scope?: ConnectorScope): Promise<Array<{from:string;to:string;fromColumn:string;toColumn:string;evidenceMethod?:'declared'|'inferred';confidence?:number;matchedCount?:number;sourceCount?:number;sampled?:boolean}> & { skippedChecks?: number; timedOutChecks?: SkippedReference[] }>;
  /** Procedures and functions: definition text as the source returns it (null when withheld), whether the source
   *  encrypts it, and the declared parameters. Callers scrub the text before storing it (decision 53). */
  routines?():Promise<Routine[]>;
  /** Who owns each table, view, procedure and function, and the order they were created: used to tell which of two
   *  near-identical routines is the copy, shown as an informational badge (decision 64). */
  objectOrigins?():Promise<ObjectOrigin[]>;
  /** View definitions for SQL lineage parsing. definition is null when the source hides it (for example an encrypted module). */
  viewDefinitions?():Promise<Array<{qualifiedName:string;schema:string;definition:string|null}>>;
  /** Distinct non-null values of one column, as text, for keyed fingerprinting by the ID agent. Values stay in memory:
   * they are fingerprinted and discarded, never stored, logged or sent to a model (non-negotiable 6). Returns null
   * when the column has more than limit distinct values. */
  distinctValues?(qualifiedName:string,column:string,limit:number,options?:{sample?:boolean}):Promise<string[]|null>;
  executeQueryIntent?(intent:unknown,includeCellSize?:boolean):Promise<{sql:string;rows:Array<Record<string,unknown>>}>;
  /** Original text of a column (for example a workbook header) when it differs from its SQL identifier. */
  categoryValues?(table: string, column: string): Promise<{sql: string; values: string[]} | undefined>;
  columnLabels?(table:string):Promise<Record<string,string>>;
  close?(): Promise<void>;
}

export { PostgresConnector, createPostgresConnector, splitRoutineArguments, type PostgresStructuralReference } from './postgres.js';
export { SqlServerConnector, createSqlServerConnector, type SqlServerConnection } from './sql-server.js';
export { encryptConnectionSecret, decryptConnectionSecret, type EncryptedConnectionSecret } from './connection-secrets.js';
export { ExcelConnector, createExcelConnector, parseWorkbook, normaliseIdentifier, type WorkbookSheet, type WorkbookColumn } from './excel.js';

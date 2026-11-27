import { groupTableKeys } from './postgres.js';
import { columnScope, objectScope } from './scope.js';
import { CATALOG_ROW_LIMIT, sourceTimeouts, withSourceDeadline, type SourceTimeoutOptions } from './limits.js';
import { inIdSample, sqlServerIdSampleCondition } from './id-sample.js';
import { DEFAULT_SAMPLING, SENSITIVITY_MIN_VALUES, SENSITIVITY_VALUES, type SamplingLimits, catalogEstimate, samplePercent } from './sampling.js';
import { createHash } from 'node:crypto';
import sql from 'mssql';
import { classifyColumn } from '@scaleinsyght/classification';
import { POSSIBLE_REFERENCE_COVERAGE, REFERENCE_CHECK_SAMPLE, isSkippableCheckError, isSourceQueryTimeout, withSkippedChecks, type SkippedReference, UNMEASURED, type ColumnStatistics, type ConnectorScope, type DiscoveryResult, type ObjectProfile, type ReadOnlyConnector , type ObjectOrigin } from './index.js';

const SQL_SERVER_TEXT = new Set(['nvarchar', 'varchar', 'nchar', 'char']);
const SQL_SERVER_MEASURABLE = new Set([...SQL_SERVER_TEXT, 'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'bit', 'date', 'datetime', 'datetime2', 'uniqueidentifier']);

type CatalogObject = { schema_name: string; object_name: string; object_type: 'U' | 'V' };
type CatalogColumn = { column_name: string; data_type: string; is_nullable: boolean; sensitivity: string | null };
const quote = (value: string) => `[${value.replaceAll(']', ']]')}]`;
const keyFor = (name: string) => createHash('sha256').update(`sql_server\0${name}`).digest('hex');

export type SqlServerConnection = { server: string; port: number; database: string; username: string; password: string; encrypt: true; trustServerCertificate?: boolean };

/** The driver gave up on a request that ran past its time limit (mssql ETIMEOUT). */
const isTimeout = (error: unknown) => (error as { code?: string })?.code === 'ETIMEOUT' || (error instanceof Error && error.message === 'source_query_timeout');

export class SqlServerConnector implements ReadOnlyConnector {
  readonly type = 'sql_server' as const;
  readonly modelRequests = 0;
  readonly id: string;
  readonly name: string;
  private readonly timeouts: ReturnType<typeof sourceTimeouts>;
  private pool: sql.ConnectionPool;
  private readonly newPool: () => sql.ConnectionPool;
  private readonly maxRows: number;
  /** Ceiling for catalog listings (tables, columns, keys, definitions), separate from the data-read row limit. */
  private readonly maxCatalogRows: number;
  private readonly objects = new Map<string, CatalogObject>();

  /** Decision 59: when to count exactly and how many rows to sample. */
  private readonly limits: SamplingLimits;
  constructor(input: SqlServerConnection & { id?: string; name?: string; maxRows?: number; maxCatalogRows?: number; sampling?: Partial<SamplingLimits> } & SourceTimeoutOptions) {
    this.limits = { ...DEFAULT_SAMPLING, ...input.sampling };
    if (!input.encrypt) throw new Error('sqlserver_encryption_required');
    this.timeouts = sourceTimeouts(input);
    this.maxRows = input.maxRows ?? 1_000;
    this.maxCatalogRows = input.maxCatalogRows ?? CATALOG_ROW_LIMIT;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1) throw new Error('sqlserver_row_limit_invalid');
    if (!Number.isSafeInteger(this.maxCatalogRows) || this.maxCatalogRows < 1) throw new Error('sqlserver_catalog_limit_invalid');
    this.newPool = () => new sql.ConnectionPool({
      server: input.server, port: input.port, database: input.database, user: input.username, password: input.password,
      options: { encrypt: true, trustServerCertificate: input.trustServerCertificate ?? false },
      connectionTimeout: this.timeouts.connect, requestTimeout: this.timeouts.query, pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    });
    this.pool = this.newPool();
    this.id = input.id ?? 'sql-server-source';
    this.name = input.name ?? 'SQL Server source';
  }

  private async request() {
    const pool = this.pool;
    if (!pool.connected) {
      const opening = pool.connect();
      try {
        await withSourceDeadline(opening, this.timeouts.connect, 'source_unreachable', () => {
          if (this.pool !== pool) return;
          this.pool = this.newPool();
          // The driver cannot close during login. Dispose this pool if a delayed login still succeeds.
          void opening.then(() => pool.close()).catch(() => undefined);
        });
      } catch (error) {
        if ((error as { code?: string })?.code === 'ETIMEOUT') throw new Error('source_unreachable', { cause: error });
        throw error;
      }
      if (this.pool !== pool) throw new Error('source_unreachable');
    }
    const request = pool.request();
    const query = request.query.bind(request);
    return {
      input(name: string, typeOrValue: unknown, ...values: unknown[]) {
        if (values.length === 0) request.input(name, typeOrValue);
        else request.input(name, typeOrValue as Parameters<sql.Request['input']>[1], values[0]);
        return this;
      },
      query: <T>(text: string) => withSourceDeadline(
        query<T>(text), this.timeouts.query, 'source_query_timeout', () => request.cancel(),
      ),
    };
  }

  async test(): Promise<{ ok: true; capabilities: ['discover', 'profile']; readOnly: true }> {
    const request = await this.request();
    const result = await request.query<{ unsafe: number }>(`SELECT CASE WHEN IS_SRVROLEMEMBER('sysadmin')=1 OR IS_SRVROLEMEMBER('securityadmin')=1 OR IS_SRVROLEMEMBER('serveradmin')=1 OR
      IS_SRVROLEMEMBER('setupadmin')=1 OR IS_SRVROLEMEMBER('processadmin')=1 OR IS_SRVROLEMEMBER('diskadmin')=1 OR IS_SRVROLEMEMBER('dbcreator')=1 OR IS_SRVROLEMEMBER('bulkadmin')=1 OR
      IS_MEMBER('db_owner')=1 OR IS_MEMBER('db_datawriter')=1 OR IS_MEMBER('db_ddladmin')=1 OR IS_MEMBER('db_securityadmin')=1 OR IS_MEMBER('db_accessadmin')=1 OR
      HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UPDATE')=1 OR
      HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','DELETE')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER')=1 OR
      HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL')=1 OR EXISTS(SELECT 1 FROM sys.objects o WHERE o.type IN ('U','V') AND
       (HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','INSERT')=1 OR
        HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','UPDATE')=1 OR
        HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','DELETE')=1 OR
        HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','ALTER')=1 OR
        HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','CONTROL')=1 OR
        HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(o.object_id))+'.'+QUOTENAME(o.name),'OBJECT','TAKE OWNERSHIP')=1)) OR EXISTS(SELECT 1 FROM sys.schemas s WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA') AND
       EXISTS(SELECT 1 FROM sys.objects o WHERE o.schema_id=s.schema_id AND o.type IN ('U','V')) AND
       (HAS_PERMS_BY_NAME(s.name,'SCHEMA','INSERT')=1 OR HAS_PERMS_BY_NAME(s.name,'SCHEMA','UPDATE')=1 OR HAS_PERMS_BY_NAME(s.name,'SCHEMA','DELETE')=1 OR
        HAS_PERMS_BY_NAME(s.name,'SCHEMA','ALTER')=1 OR HAS_PERMS_BY_NAME(s.name,'SCHEMA','CONTROL')=1 OR HAS_PERMS_BY_NAME(s.name,'SCHEMA','TAKE OWNERSHIP')=1)) THEN 1 ELSE 0 END AS unsafe;`);
    if (result.recordset.length !== 1 || Number(result.recordset[0]?.unsafe) !== 0) throw new Error('sqlserver_connector_role_not_read_only');
    await request.query('SELECT TOP (1) name FROM sys.tables');
    return { ok: true, capabilities: ['discover', 'profile'], readOnly: true };
  }

  private async catalog(): Promise<CatalogObject[]> {
    const result = await (await this.request()).query<CatalogObject>(`SELECT TOP (${this.maxCatalogRows + 1}) s.name AS schema_name,o.name AS object_name,RTRIM(o.type) AS object_type
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND s.name NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY s.name,o.name`);
    if (result.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return result.recordset;
  }

  private async columns(object: CatalogObject): Promise<CatalogColumn[]> {
    const result = await (await this.request()).input('schema', sql.NVarChar, object.schema_name).input('object', sql.NVarChar, object.object_name).query<CatalogColumn>(`SELECT TOP (${this.maxCatalogRows + 1}) c.name AS column_name,t.name AS data_type,c.is_nullable,
      CONVERT(nvarchar(200),ep.value) AS sensitivity FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id
      JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id
      LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id AND ep.minor_id=c.column_id AND ep.name='sensitivity'
      WHERE s.name=@schema AND o.name=@object ORDER BY c.column_id`);
    if (result.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return result.recordset;
  }

  async discover(input: { mode: 'profile'|'nightly'; scope?: ConnectorScope }): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { objects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: 0, accessible: 0, inaccessible: 0 }, unchanged: 0, unchangedObjects: [] };
    this.objects.clear();
    for (const object of await this.catalog()) {
      const qualifiedName = `${object.schema_name}.${object.object_name}`;
      const type = object.object_type === 'V' ? 'view' : 'table';
      const key = keyFor(qualifiedName);
      this.objects.set(qualifiedName, object); result.coverage.listed++;
      const objectType=type;
      const mode=objectScope(input.scope,qualifiedName,objectType);
      if(mode==='exclude'){result.excludedObjects.push({qualifiedName,type:objectType});continue;}
      if(mode==='list_only'){result.listOnlyObjects.push({qualifiedName,type:objectType});continue;}
      result.objects.push({ assetKey: key, qualifiedName, type, scopeMode: 'profile' }); result.coverage.accessible++;
    }
    return result;
  }

  async profile(assetKey: string, scope?: ConnectorScope): Promise<ObjectProfile> {
    const found = [...this.objects].find(([name]) => keyFor(name) === assetKey);
    if (!found) throw new Error('asset_not_found');
    const [qualifiedName, object] = found;
    if(objectScope(scope,qualifiedName,object.object_type==='V'?'view':'table')!=='profile') throw new Error('object_out_of_scope');
    const columns = (await this.columns(object)).filter(column=>columnScope(scope,qualifiedName,column.column_name)!=='exclude');
    const fullName = `${quote(object.schema_name)}.${quote(object.object_name)}`;
    // Decision 59: the size comes from sys.partitions (no scan); small tables are counted exactly.
    const table = object.object_type !== 'V';
    let estimate: number | null = null;
    let limited: 'timeout' | undefined;
    if (table) { try { const partitions = await (await this.request()).input('id', sql.NVarChar, `${quote(object.schema_name)}.${quote(object.object_name)}`).query<{ rows: number | null }>('SELECT SUM(p.rows) AS rows FROM sys.partitions p WHERE p.object_id=OBJECT_ID(@id) AND p.index_id IN (0,1)'); estimate = catalogEstimate(partitions.recordset[0]?.rows === null || partitions.recordset[0]?.rows === undefined ? null : Number(partitions.recordset[0].rows)); } catch (error) { if (isSourceQueryTimeout(error)) limited = 'timeout'; } }
    let rowCount: number | null = null; let rowCountEstimated = false;
    if (estimate !== null && estimate > this.limits.exactCountLimit) { rowCount = estimate; rowCountEstimated = true; }
    else {
      try {
        const counted = await (await this.request()).query<{row_count:number}>(`SELECT COUNT_BIG(*) AS row_count FROM ${fullName}`);
        rowCount = counted.recordset[0]?.row_count == null ? null : Number(counted.recordset[0].row_count);
      } catch (error) {
        if (isSourceQueryTimeout(error)) limited = 'timeout';
        if (estimate !== null) { rowCount = estimate; rowCountEstimated = true; }
      }
    }
    // TABLESAMPLE works on tables only; a view is read with a plain row limit.
    const sampled = (wanted: number) => { const percent = table ? samplePercent(rowCount, wanted) : null; return percent === null ? '' : ` TABLESAMPLE SYSTEM (${percent} PERCENT)`; };
    // Bounded text samples feed the sensitivity detector only; they are discarded here and never stored or sent to a model (decision 41).
    // One query samples every text column; a sparse column gets its own non-null sample. A query that still runs out of
    // time leaves the table without samples or statistics (bug 6), so an unsampled column never gets statistics (contract 7).
    const samples = new Map<string, string[]>();
    const textColumns = rowCount === null ? [] : columns.filter((column) => !columnScope(scope, qualifiedName, column.column_name) && ['nvarchar', 'varchar', 'nchar', 'char'].includes(column.data_type));
    try {
      if (textColumns.length) {
        const rows = (await (await this.request()).query<Record<string, string | null>>(`SELECT TOP (${this.limits.sensitivitySampleRows}) ${textColumns.map((column, index) => `CAST(${quote(column.column_name)} AS nvarchar(400)) AS t${index}`).join(',')} FROM ${fullName}${sampled(this.limits.sensitivitySampleRows)}`)).recordset;
        textColumns.forEach((column, index) => samples.set(column.column_name, rows.map((row) => row[`t${index}`]).filter((value): value is string => value !== null).slice(0, SENSITIVITY_VALUES)));
        // Sparse text columns get more values in one further query per table, reading only rows where one of them is set.
        const sparse = textColumns.filter((column) => samples.get(column.column_name)!.length < SENSITIVITY_MIN_VALUES && (rowCount ?? 0) > samples.get(column.column_name)!.length);
        if (sparse.length) {
          const more = (await (await this.request()).query<Record<string, string | null>>(`SELECT TOP (${this.limits.sensitivitySampleRows}) ${sparse.map((column, index) => `CAST(${quote(column.column_name)} AS nvarchar(400)) AS s${index}`).join(',')} FROM ${fullName}${sampled(this.limits.statisticsSampleRows)} WHERE ${sparse.map((column) => `${quote(column.column_name)} IS NOT NULL`).join(' OR ')}`)).recordset;
          sparse.forEach((column, index) => samples.set(column.column_name, [...samples.get(column.column_name)!, ...more.map((row) => row[`s${index}`]).filter((value): value is string => value !== null)].slice(0, SENSITIVITY_VALUES)));
        }
      }
    } catch (error) { if (!isTimeout(error)) throw error; limited = 'timeout'; samples.clear(); }
    const classified = new Map(columns.map((column) => [column.column_name, classifyColumn({ name: column.column_name, declaredTags: [...(column.sensitivity ? [column.sensitivity.replace(/^sensitivity:/, '')] : []), ...(columnScope(scope,qualifiedName,column.column_name)==='mask'?['personal']:[])], sample: samples.get(column.column_name) ?? [] })] as const));
    // Null rate, distinct count and average text length on untagged scalar columns, in one query per table: exact on a
    // small table; on a large one null rate and length come from a capped TABLESAMPLE and are marked as estimates. A
    // distinct count from a sample is never reported, so a large table's distinct counts stay unknown.
    const measurable = !limited && rowCount !== null && rowCount > 0 ? columns.filter((column) => !classified.get(column.column_name)!.tags.length && !columnScope(scope, qualifiedName, column.column_name) && SQL_SERVER_MEASURABLE.has(column.data_type)) : [];
    const statistics = new Map<string, ColumnStatistics>();
    if (measurable.length) {
      const estimated = rowCountEstimated || rowCount! > this.limits.statisticsSampleRows;
      const parts = measurable.flatMap((column, index) => { const ref = quote(column.column_name); return [`COUNT_BIG(${ref}) AS n${index}`, ...(estimated ? [] : [`COUNT_BIG(DISTINCT ${ref}) AS d${index}`]), SQL_SERVER_TEXT.has(column.data_type) ? `AVG(CAST(LEN(${ref}) AS float)) AS l${index}` : `CAST(NULL AS float) AS l${index}`]; });
      const from = estimated ? `(SELECT TOP (${this.limits.statisticsSampleRows}) ${measurable.map((column) => quote(column.column_name)).join(',')} FROM ${fullName}${sampled(this.limits.statisticsSampleRows)}) AS sampled` : fullName;
      let measured: Record<string, string | number | null> | undefined;
      try { measured = (await (await this.request()).query<Record<string, string | number | null>>(`SELECT COUNT_BIG(*) AS total,${parts.join(',')} FROM ${from}`)).recordset[0]!; }
      catch (error) { if (!isTimeout(error)) throw error; limited = 'timeout'; }
      const total = Number(measured?.total ?? 0);
      if (measured && total > 0) measurable.forEach((column, index) => statistics.set(column.column_name, { nullRate: 1 - Number(measured![`n${index}`]) / total, distinctCount: estimated ? null : Number(measured![`d${index}`]), averageLength: measured![`l${index}`] === null ? null : Number(measured![`l${index}`]), ...(estimated ? { estimated: true } : {}) }));
    }
    return { assetKey, qualifiedName, version: createHash('sha256').update(JSON.stringify(columns)).digest('hex'), rowCount, ...(rowCountEstimated ? { rowCountEstimated: true } : {}), ...(limited ? { limited } : {}), columns: columns.map((column) => { const found = classified.get(column.column_name)!; return { name: column.column_name, dataType: column.data_type, isNullable: column.is_nullable, ...(columnScope(scope, qualifiedName, column.column_name) === 'mask' ? { sensitivityTags: [...new Set([...found.tags, 'personal'])], sensitivityEvidence: [...found.evidence, { tag: 'personal', detection: 'declared' as const, reason: 'Masked in Controls' }] } : { sensitivityTags: found.tags, sensitivityEvidence: found.evidence }), statistics: statistics.get(column.column_name) ?? UNMEASURED }; }) };
  }

  async structuralReferences(scope?: ConnectorScope) {
    const rows = await (await this.request()).query<{ from: string; to: string; fromColumn: string; toColumn: string }>(`SELECT TOP (${this.maxCatalogRows + 1}) ps.name+'.'+pt.name AS [from],rs.name+'.'+rt.name AS [to],pc.name AS fromColumn,rc.name AS toColumn
      FROM sys.foreign_key_columns f JOIN sys.tables pt ON pt.object_id=f.parent_object_id JOIN sys.schemas ps ON ps.schema_id=pt.schema_id
      JOIN sys.columns pc ON pc.object_id=f.parent_object_id AND pc.column_id=f.parent_column_id JOIN sys.tables rt ON rt.object_id=f.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id=rt.schema_id JOIN sys.columns rc ON rc.object_id=f.referenced_object_id AND rc.column_id=f.referenced_column_id ORDER BY [from],[to]`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const permits=(table:string,column:string)=>objectScope(scope,table,'table')==='profile'&&!columnScope(scope,table,column);
    let skippedChecks = 0; const timedOutChecks: SkippedReference[] = [];
    const references: Array<{ from: string; to: string; fromColumn: string; toColumn: string; evidenceMethod: 'declared' | 'inferred'; confidence?:number; matchedCount?:number; sourceCount?:number; sampled?:boolean }> = rows.recordset.filter(item=>permits(item.from,item.fromColumn)&&permits(item.to,item.toColumn)).map((row) => ({ ...row, evidenceMethod: 'declared' }));
    const candidates = await (await this.request()).query<{ from: string; to: string; fromColumn: string; toColumn: string }>(`SELECT TOP (${this.maxCatalogRows}) ss.name+'.'+st.name AS [from],ts.name+'.'+tt.name AS [to],sc.name AS fromColumn,tc.name AS toColumn
      FROM sys.columns sc JOIN sys.tables st ON st.object_id=sc.object_id JOIN sys.schemas ss ON ss.schema_id=st.schema_id
      JOIN sys.columns tc ON tc.name=sc.name JOIN sys.tables tt ON tt.object_id=tc.object_id JOIN sys.schemas ts ON ts.schema_id=tt.schema_id
      JOIN sys.types stype ON stype.user_type_id=sc.user_type_id JOIN sys.types ttype ON ttype.user_type_id=tc.user_type_id AND ttype.system_type_id=stype.system_type_id
      JOIN sys.index_columns ik ON ik.object_id=tc.object_id AND ik.column_id=tc.column_id JOIN sys.indexes ix ON ix.object_id=ik.object_id AND ix.index_id=ik.index_id AND ix.is_primary_key=1
      WHERE st.object_id<>tt.object_id AND ss.name NOT IN ('sys','INFORMATION_SCHEMA') AND ts.name NOT IN ('sys','INFORMATION_SCHEMA')
      AND NOT EXISTS(SELECT 1 FROM sys.index_columns sik JOIN sys.indexes six ON six.object_id=sik.object_id AND six.index_id=sik.index_id AND six.is_primary_key=1 WHERE sik.object_id=sc.object_id AND sik.column_id=sc.column_id)
      ORDER BY [from],[to],fromColumn`);
    for (const candidate of candidates.recordset) {
      if(!permits(candidate.from,candidate.fromColumn)||!permits(candidate.to,candidate.toColumn))continue;
      if (references.some((item) => item.from === candidate.from && item.fromColumn === candidate.fromColumn && item.to === candidate.to && item.toColumn === candidate.toColumn)) continue;
      const [fromSchema, fromName] = candidate.from.split('.'); const [toSchema, toName] = candidate.to.split('.');
      if (!fromSchema || !fromName || !toSchema || !toName) continue;
      // Decision 63: the first REFERENCE_CHECK_SAMPLE non-null values, each looked up in the target's primary key (a
      // single-column key, so the join cannot repeat a source value).
      let count;
      try { count = await (await this.request()).query<{ source_count: number; matched_count: number }>(`SELECT COUNT_BIG(*) AS source_count, COUNT_BIG(dst.${quote(candidate.toColumn)}) AS matched_count
        FROM (SELECT TOP (${REFERENCE_CHECK_SAMPLE}) ${quote(candidate.fromColumn)} AS v FROM ${quote(fromSchema)}.${quote(fromName)} WHERE ${quote(candidate.fromColumn)} IS NOT NULL) src
        LEFT JOIN ${quote(toSchema)}.${quote(toName)} dst ON dst.${quote(candidate.toColumn)} = src.v`); }
      catch (error) { if (!isSkippableCheckError(error)) throw error; skippedChecks++; if (isSourceQueryTimeout(error)) timedOutChecks.push(candidate); continue; }
      const sourceCount = Number(count.recordset[0]?.source_count ?? 0); const matchedCount = Number(count.recordset[0]?.matched_count ?? 0);
      if (sourceCount > 0 && matchedCount / sourceCount >= POSSIBLE_REFERENCE_COVERAGE) references.push({ ...candidate, evidenceMethod: 'inferred',confidence:matchedCount/sourceCount,matchedCount,sourceCount,sampled:sourceCount>=REFERENCE_CHECK_SAMPLE });
      if (references.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    }
    return withSkippedChecks(references, skippedChecks, timedOutChecks);
  }

  /** Distinct values for the ID agent; with sample, only values the consistent rule keeps (decision 61), selected in SQL. */
  async distinctValues(qualifiedName: string, column: string, limit: number, options: { sample?: boolean } = {}): Promise<string[] | null> {
    const object = this.objects.get(qualifiedName); if (!object) throw new Error('asset_not_found');
    if (!(await this.columns(object)).some((item) => item.column_name === column)) throw new Error('column_not_found');
    const ref = quote(column);
    const result = await (await this.request()).query<{ v: string }>(`SELECT DISTINCT TOP (${limit + 1}) CAST(${ref} AS nvarchar(400)) AS v FROM ${quote(object.schema_name)}.${quote(object.object_name)} WHERE ${ref} IS NOT NULL${options.sample ? ` AND ${sqlServerIdSampleCondition(`CAST(${ref} AS nvarchar(400))`)}` : ''}`);
    const rows = options.sample ? result.recordset.filter((row) => inIdSample(row.v)) : result.recordset;
    return result.recordset.length > limit ? null : rows.map((row) => row.v);
  }

  async viewDefinitions(): Promise<Array<{ qualifiedName: string; schema: string; definition: string | null }>> {
    const rows = await (await this.request()).query<{ qualified_name: string; schema_name: string; definition: string | null }>(`SELECT TOP (${this.maxCatalogRows + 1}) s.name+'.'+v.name AS qualified_name,s.name AS schema_name,m.definition
      FROM sys.views v JOIN sys.schemas s ON s.schema_id=v.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=v.object_id ORDER BY qualified_name`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return rows.recordset.map((row) => ({ qualifiedName: row.qualified_name, schema: row.schema_name, definition: row.definition }));
  }

  /** Owners and creation order of tables, views, procedures and functions (decision 62). */
  async objectOrigins(): Promise<ObjectOrigin[]> {
    const rows = await (await this.request()).query<{ qualified_name: string; owner: string | null; created_order: number | null }>(`SELECT TOP (${this.maxCatalogRows + 1}) s.name+'.'+o.name AS qualified_name,
        COALESCE(USER_NAME(o.principal_id),USER_NAME(s.principal_id)) AS owner,DATEDIFF_BIG(second,'19700101',o.create_date) AS created_order
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped=0`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return rows.recordset.map((row) => ({ qualifiedName: row.qualified_name, owner: row.owner, createdOrder: row.created_order === null ? null : Number(row.created_order) }));
  }

  async keysAndIndexes() {
    // Catalog only (sys.indexes): key columns in key order; included columns are not part of a key.
    const rows = await (await this.request()).query<{ table_name: string; index_name: string; is_primary_key: boolean; is_unique: boolean; columns: string }>(`SELECT TOP (${this.maxCatalogRows + 1}) s.name+'.'+t.name AS table_name,i.name AS index_name,i.is_primary_key,i.is_unique,
        STRING_AGG(c.name, NCHAR(31)) WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
      FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
      JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=0
      JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
      WHERE i.type>0 AND i.is_hypothetical=0 AND t.is_ms_shipped=0 GROUP BY s.name,t.name,i.name,i.is_primary_key,i.is_unique ORDER BY 1,2`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return groupTableKeys(rows.recordset.map((row) => ({ table: row.table_name, name: row.index_name, columns: row.columns.split(String.fromCharCode(31)), unique: Boolean(row.is_unique), primary: Boolean(row.is_primary_key) })));
  }

  async routineDependencies() {
    // sys.sql_expression_dependencies is recorded at create time, so it is there for encrypted modules too.
    const rows = await (await this.request()).query<{ routine: string; referenced: string }>(`SELECT TOP (${this.maxCatalogRows + 1}) s.name+'.'+o.name AS routine,
        COALESCE(d.referenced_schema_name, SCHEMA_NAME(ro.schema_id), s.name)+'.'+d.referenced_entity_name AS referenced
      FROM sys.sql_expression_dependencies d JOIN sys.objects o ON o.object_id=d.referencing_id JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.objects ro ON ro.object_id=d.referenced_id
      WHERE o.type IN ('P','FN','IF','TF') AND d.referenced_database_name IS NULL AND d.referenced_server_name IS NULL ORDER BY 1,2`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const byRoutine = new Map<string, string[]>();
    for (const row of rows.recordset) byRoutine.set(row.routine, [...new Set([...(byRoutine.get(row.routine) ?? []), row.referenced])]);
    return [...byRoutine].map(([routine, references]) => ({ routine, references }));
  }

  async routines() {
    // An encrypted module has no definition in sys.sql_modules (is_encrypted = 1); it is reported as encrypted, not empty.
    const rows = await (await this.request()).query<{ object_id: number; qualified_name: string; kind: 'function'|'procedure'; definition: string | null; encrypted: boolean }>(`SELECT TOP (${this.maxCatalogRows + 1}) o.object_id,s.name+'.'+o.name AS qualified_name,CASE WHEN o.type='P' THEN 'procedure' ELSE 'function' END AS kind,OBJECT_DEFINITION(o.object_id) AS definition,
        CAST(COALESCE(OBJECTPROPERTY(o.object_id,'IsEncrypted'),0) AS bit) AS encrypted
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY s.name,o.name`);
    if (rows.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const parameters = await (await this.request()).query<{ object_id: number; name: string; data_type: string; is_output: boolean }>(`SELECT TOP (${this.maxCatalogRows + 1}) p.object_id,p.name,TYPE_NAME(p.user_type_id) AS data_type,p.is_output
      FROM sys.parameters p JOIN sys.objects o ON o.object_id=p.object_id WHERE o.type IN ('P','FN','IF','TF') AND p.parameter_id>0 ORDER BY p.object_id,p.parameter_id`);
    if (parameters.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const byObject = new Map<number, Array<{ name: string; dataType: string; mode: 'in' | 'out' | 'inout' }>>();
    for (const parameter of parameters.recordset) byObject.set(parameter.object_id, [...(byObject.get(parameter.object_id) ?? []), { name: parameter.name, dataType: parameter.data_type, mode: parameter.is_output ? 'inout' : 'in' }]);
    // A table-valued function's returned columns are in sys.columns, not sys.parameters (decision 64).
    const returned = await (await this.request()).query<{ object_id: number; name: string; data_type: string }>(`SELECT TOP (${this.maxCatalogRows + 1}) c.object_id,c.name,TYPE_NAME(c.user_type_id) AS data_type
      FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id WHERE o.type IN ('IF','TF') ORDER BY c.object_id,c.column_id`);
    if (returned.recordset.length > this.maxCatalogRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const returnsByObject = new Map<number, Array<{ name: string; dataType: string }>>();
    for (const column of returned.recordset) returnsByObject.set(column.object_id, [...(returnsByObject.get(column.object_id) ?? []), { name: column.name, dataType: column.data_type }]);
    return rows.recordset.map((row) => ({ qualifiedName: row.qualified_name, kind: row.kind, definition: row.encrypted ? null : row.definition, encrypted: Boolean(row.encrypted),
      parameters: byObject.get(row.object_id) ?? [], returns: returnsByObject.get(row.object_id) ?? [] }));
  }

  async categoryValues(table: string, column: string): Promise<{sql: string; values: string[]} | undefined> {
    const target = this.objects.get(table);
    if (!target || !(await this.columns(target)).some(field => field.column_name === column && /^(n?varchar|n?char)$/.test(field.data_type))) return;
    const key = quote(column);
    const sql = `SELECT DISTINCT TOP (101) ${key} AS value FROM ${quote(target.schema_name)}.${quote(target.object_name)} WHERE ${key} IS NOT NULL ORDER BY value`;
    const result = await (await this.request()).query<{value: string}>(sql);
    return {sql, values: result.recordset.map(row => row.value)};
  }

  async executeQueryIntent(raw: unknown, includeCellSize=false): Promise<{ sql: string; rows: Array<Record<string, unknown>> }> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('analytic_query_intent_invalid');
    const intent = raw as Record<string, unknown>; const request = await this.request();
    const object = (name: unknown): CatalogObject => { if (typeof name !== 'string') throw new Error('analytic_query_asset_not_found'); const found = this.objects.get(name); if (!found) throw new Error('analytic_query_asset_not_found'); return found; };
    const column = async (target: CatalogObject, name: unknown) => { if (typeof name !== 'string' || !(await this.columns(target)).some((item) => item.column_name === name)) throw new Error('analytic_query_column_not_found'); return quote(name); };
    const aggregate = async (target: CatalogObject, rawAggregate: unknown) => { if (!rawAggregate || typeof rawAggregate !== 'object') throw new Error('analytic_query_intent_invalid'); const spec = rawAggregate as Record<string, unknown>; if (spec.operation === 'count') return 'COUNT_BIG(*)'; if (spec.operation === 'sum') return `COALESCE(SUM(${await column(target, spec.column)}),0)`; throw new Error('analytic_query_intent_invalid'); };
    const filterWhere = async (filters: unknown, left: CatalogObject, right?: CatalogObject) => {
      if (!Array.isArray(filters)) throw new Error('analytic_query_intent_invalid'); const clauses: string[] = [];
      for (let index=0; index<filters.length; index++) { const filter=filters[index] as Record<string,unknown>; if(!filter||typeof filter!=='object'||Array.isArray(filter))throw new Error('analytic_query_intent_invalid');const target=filter.table===undefined?left:filter.table===intent.leftTable||filter.table==='left'?left:filter.table===intent.rightTable||filter.table==='right'?right:undefined;if(!target)throw new Error('analytic_query_intent_invalid');const col=await column(target,filter.column);const alias=target===left?'l':'r';if(filter.operator==='is_not_null'){clauses.push(`${alias}.${col} IS NOT NULL`);continue;}const op=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Record<string,string>)[String(filter.operator)];if(!op||!['string','number','boolean'].includes(typeof filter.value))throw new Error('analytic_query_intent_invalid');request.input(`filter${index}`,filter.value as string|number|boolean);clauses.push(`${alias}.${col} ${op} @filter${index}`);}
      return clauses.length?` WHERE ${clauses.join(' AND ')}`:'';
    };
    // Further conditions on a single table (filtered_count and group_by, decision 54), bound as parameters.
    const sameTable = async (target: CatalogObject, filters: unknown): Promise<string[]> => { if (filters === undefined) return []; if (!Array.isArray(filters)) throw new Error('analytic_query_intent_invalid'); const clauses: string[] = []; for (let index = 0; index < filters.length; index++) { const filter = filters[index] as Record<string, unknown>; if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('analytic_query_intent_invalid'); const col = await column(target, filter.column); if (filter.operator === 'is_not_null') { clauses.push(`${col} IS NOT NULL`); continue; } const op = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[String(filter.operator)]; if (!op || !['string', 'number', 'boolean'].includes(typeof filter.value)) throw new Error('analytic_query_intent_invalid'); request.input(`condition${index}`, filter.value as string | number | boolean); clauses.push(`${col} ${op} @condition${index}`); } return clauses; };
    let query: string;const cellSize=includeCellSize?',COUNT_BIG(*) AS cell_size':'';
    if (intent.kind === 'count' || intent.kind === 'compare_aggregates') { const target = object(intent.table); const expression = intent.kind === 'count' ? 'COUNT_BIG(*)' : await aggregate(target, intent.aggregate); query = `SELECT TOP (1) ${expression} AS value${cellSize} FROM ${quote(target.schema_name)}.${quote(target.object_name)}`; }
    else if (intent.kind === 'filtered_count') { const target=object(intent.table);const col=await column(target,intent.column);if(intent.operator==='is_not_null')query=`SELECT TOP (1) COUNT_BIG(*) AS value${cellSize} FROM ${quote(target.schema_name)}.${quote(target.object_name)} WHERE ${col} IS NOT NULL`;else{const operator=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Record<string,string>)[String(intent.operator)];if(!operator||!['string','number','boolean'].includes(typeof intent.value))throw new Error('analytic_query_intent_invalid');request.input('filterValue',intent.value as string|number|boolean);query=`SELECT TOP (1) COUNT_BIG(*) AS value${cellSize} FROM ${quote(target.schema_name)}.${quote(target.object_name)} WHERE ${col} ${operator} @filterValue`;if(intent.upperExclusive!==undefined){if(intent.operator!=='gte'||typeof intent.upperExclusive!=='string')throw new Error('analytic_query_intent_invalid');request.input('upperExclusive',intent.upperExclusive);query+=` AND ${col} < @upperExclusive`;} } const extra=await sameTable(target,intent.filters);if(extra.length)query+=` AND ${extra.join(' AND ')}`; }
    else if (intent.kind === 'group_by') { const target=object(intent.table);const group=await column(target,intent.groupBy);const expression=await aggregate(target,intent.aggregate);const direction=intent.order==='desc'?'DESC':'ASC';const order=intent.orderBy==='value'?`${expression} ${direction},${group} ASC`:`${group} ${direction}`;const limit=Math.min(Number(intent.limit)||this.maxRows,100);const where=await sameTable(target,intent.filters);query=`SELECT TOP (${limit}) CAST(${group} AS nvarchar(4000)) AS group_value,${expression} AS value${cellSize} FROM ${quote(target.schema_name)}.${quote(target.object_name)}${where.length?` WHERE ${where.join(' AND ')}`:''} GROUP BY ${group} ORDER BY ${order}`; }
    else if (intent.kind === 'join_aggregate' || intent.kind === 'grouped_join') { const left=object(intent.leftTable);const right=object(intent.rightTable);const lcol=await column(left,intent.leftColumn);const rcol=await column(right,intent.rightColumn);// K12: "each department" counts from the department table, so a department with no orders shows 0 (see postgres.ts).
      const zero=intent.kind==='grouped_join'&&intent.emptyGroups==='zero'&&intent.groupByTable==='right';
      const factFilters=((intent.filters??[]) as Array<{table?:string}>).filter((filter:{table?:string})=>filter.table==='left'||filter.table===intent.leftTable);const dimensionFilters=((intent.filters??[]) as Array<{table?:string}>).filter((filter:{table?:string})=>!(filter.table==='left'||filter.table===intent.leftTable));
      const spec=intent.aggregate as {operation?:string;column?:string};
      const expression=zero?(spec.operation==='sum'?`COALESCE(SUM(l.${await column(left,spec.column)}),0)`:`COUNT_BIG(l.${lcol})`):await aggregate(left,intent.aggregate);
      const on=zero?(await filterWhere(factFilters,left,right)).replace(/^ WHERE /,' AND '):'';
      const from=zero?` FROM ${quote(right.schema_name)}.${quote(right.object_name)} r LEFT JOIN ${quote(left.schema_name)}.${quote(left.object_name)} l ON l.${lcol}=r.${rcol}${on}`:` FROM ${quote(left.schema_name)}.${quote(left.object_name)} l JOIN ${quote(right.schema_name)}.${quote(right.object_name)} r ON l.${lcol}=r.${rcol}`;
      const where=await filterWhere(zero?dimensionFilters:intent.filters??[],left,right);const cell=zero&&includeCellSize?`,COUNT_BIG(l.${lcol}) AS cell_size`:cellSize;if(intent.kind==='join_aggregate')query=`SELECT TOP (1) ${expression} AS value${cell}${from}${where}`;else{const target=intent.groupByTable==='left'?left:right;const alias=intent.groupByTable==='left'?'l':'r';const group=await column(target,intent.groupBy);const direction=intent.order==='desc'?'DESC':'ASC';const limit=Math.min(Number(intent.limit)||100,100);const key=intent.groupKey?await column(target,intent.groupKey):null;query=`SELECT TOP (${limit}) CAST(${alias}.${group} AS nvarchar(4000)) AS group_value,${key?`CAST(${alias}.${key} AS nvarchar(4000)) AS group_key,`:''}${expression} AS value${cell}${from}${where} GROUP BY ${alias}.${group}${key?`,${alias}.${key}`:''} ORDER BY value ${direction},${key?`${alias}.${key}`:'group_value'} ASC`;}}
    else if (intent.kind === 'average_count_by') {const target=object(intent.table);const entity=await column(target,intent.entityColumn);const group=await column(target,intent.groupBy);const limit=Math.min(Number(intent.limit)||100,100);query=`SELECT TOP (${limit}) group_value,AVG(CAST(entity_count AS float)) AS value${cellSize} FROM (SELECT ${group} AS group_sort,CAST(${group} AS nvarchar(4000)) AS group_value,${entity} AS entity_key,COUNT_BIG(*) AS entity_count FROM ${quote(target.schema_name)}.${quote(target.object_name)} GROUP BY ${group},${entity}) AS entity_counts GROUP BY group_sort,group_value ORDER BY group_sort`;}
    else throw new Error('analytic_query_intent_invalid');
    const result=await request.query(query);if(result.recordset.length>this.maxRows)throw new Error('sqlserver_connector_result_limit_exceeded');return{sql:query,rows:result.recordset as Array<Record<string,unknown>>};
  }

  async queryAggregate(assetKey: string, metric: 'count') { if (metric !== 'count') throw new Error('connector_query_not_supported'); const found = [...this.objects].find(([name]) => keyFor(name) === assetKey); if (!found) throw new Error('asset_not_found'); const object = found[1]; const result = await (await this.request()).query<{ value: number }>(`SELECT TOP (1) COUNT_BIG(*) AS value FROM ${quote(object.schema_name)}.${quote(object.object_name)}`); return { metric: 'count' as const, value: Number(result.recordset[0]?.value ?? 0) }; }
  async close() { await withSourceDeadline(this.pool.close(), this.timeouts.connect, 'source_close_timeout').catch(() => undefined); }
}

export function createSqlServerConnector(input: SqlServerConnection & { id?: string; name?: string; maxRows?: number; maxCatalogRows?: number; sampling?: Partial<SamplingLimits> } & SourceTimeoutOptions) { return new SqlServerConnector(input); }

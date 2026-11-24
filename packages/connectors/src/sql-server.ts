import { createHash } from 'node:crypto';
import sql from 'mssql';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector } from './index.js';

type CatalogObject = { schema_name: string; object_name: string; object_type: 'U' | 'V' };
type CatalogColumn = { column_name: string; data_type: string; is_nullable: boolean; sensitivity: string | null };
const quote = (value: string) => `[${value.replaceAll(']', ']]')}]`;
const keyFor = (name: string) => createHash('sha256').update(`sql_server\0${name}`).digest('hex');

export type SqlServerConnection = { server: string; port: number; database: string; username: string; password: string; encrypt: true; trustServerCertificate?: boolean };

export class SqlServerConnector implements ReadOnlyConnector {
  readonly type = 'sql_server' as const;
  readonly modelRequests = 0;
  readonly id: string;
  readonly name: string;
  private readonly pool: sql.ConnectionPool;
  private readonly maxRows: number;
  private readonly objects = new Map<string, CatalogObject>();

  constructor(input: SqlServerConnection & { id?: string; name?: string; statementTimeoutMs?: number; maxRows?: number }) {
    if (!input.encrypt) throw new Error('sqlserver_encryption_required');
    const statementTimeoutMs = input.statementTimeoutMs ?? 10_000;
    this.maxRows = input.maxRows ?? 1_000;
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) throw new Error('sqlserver_statement_timeout_invalid');
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1) throw new Error('sqlserver_row_limit_invalid');
    this.pool = new sql.ConnectionPool({
      server: input.server, port: input.port, database: input.database, user: input.username, password: input.password,
      options: { encrypt: true, trustServerCertificate: input.trustServerCertificate ?? false },
      connectionTimeout: 5_000, requestTimeout: statementTimeoutMs, pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    });
    this.id = input.id ?? 'sql-server-source';
    this.name = input.name ?? 'SQL Server source';
  }

  private async request() { if (!this.pool.connected) await this.pool.connect(); return this.pool.request(); }

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
    const result = await (await this.request()).query<CatalogObject>(`SELECT TOP (${this.maxRows + 1}) s.name AS schema_name,o.name AS object_name,o.type AS object_type
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND s.name NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY s.name,o.name`);
    if (result.recordset.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return result.recordset;
  }

  private async columns(object: CatalogObject): Promise<CatalogColumn[]> {
    const result = await (await this.request()).input('schema', sql.NVarChar, object.schema_name).input('object', sql.NVarChar, object.object_name).query<CatalogColumn>(`SELECT TOP (${this.maxRows + 1}) c.name AS column_name,t.name AS data_type,c.is_nullable,
      CONVERT(nvarchar(200),ep.value) AS sensitivity FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id
      JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id
      LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id AND ep.minor_id=c.column_id AND ep.name='sensitivity'
      WHERE s.name=@schema AND o.name=@object ORDER BY c.column_id`);
    if (result.recordset.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
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
      if (input.scope?.exclude?.includes(qualifiedName) || (input.scope?.profile?.length && !input.scope.profile.includes(qualifiedName))) { result.excludedObjects.push({ qualifiedName, type }); continue; }
      if (input.scope?.listOnly?.includes(qualifiedName)) { result.listOnlyObjects.push({ qualifiedName, type }); continue; }
      result.objects.push({ assetKey: key, qualifiedName, type, scopeMode: 'profile' }); result.coverage.accessible++;
    }
    return result;
  }

  async profile(assetKey: string): Promise<ObjectProfile> {
    const found = [...this.objects].find(([name]) => keyFor(name) === assetKey);
    if (!found) throw new Error('asset_not_found');
    const [qualifiedName, object] = found;
    const columns = await this.columns(object);
    const fullName = `${quote(object.schema_name)}.${quote(object.object_name)}`;
    const counted = await (await this.request()).query<{ row_count: number }>(`SELECT COUNT_BIG(*) AS row_count FROM ${fullName}`);
    return { assetKey, qualifiedName, version: createHash('sha256').update(JSON.stringify(columns)).digest('hex'), rowCount: Number(counted.recordset[0]?.row_count ?? 0), columns: columns.map((column) => ({ name: column.column_name, dataType: column.data_type, isNullable: column.is_nullable, sensitivityTags: column.sensitivity ? [column.sensitivity.replace(/^sensitivity:/, '')] : [], statistics: { nullRate: null, distinctCount: null } })) };
  }

  async structuralReferences() {
    const rows = await (await this.request()).query<{ from: string; to: string; fromColumn: string; toColumn: string }>(`SELECT TOP (${this.maxRows + 1}) ps.name+'.'+pt.name AS [from],rs.name+'.'+rt.name AS [to],pc.name AS fromColumn,rc.name AS toColumn
      FROM sys.foreign_key_columns f JOIN sys.tables pt ON pt.object_id=f.parent_object_id JOIN sys.schemas ps ON ps.schema_id=pt.schema_id
      JOIN sys.columns pc ON pc.object_id=f.parent_object_id AND pc.column_id=f.parent_column_id JOIN sys.tables rt ON rt.object_id=f.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id=rt.schema_id JOIN sys.columns rc ON rc.object_id=f.referenced_object_id AND rc.column_id=f.referenced_column_id ORDER BY [from],[to]`);
    if (rows.recordset.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    const references: Array<{ from: string; to: string; fromColumn: string; toColumn: string; evidenceMethod: 'declared' | 'inferred' }> = rows.recordset.map((row) => ({ ...row, evidenceMethod: 'declared' }));
    const candidates = await (await this.request()).query<{ from: string; to: string; fromColumn: string; toColumn: string }>(`SELECT TOP (${this.maxRows}) ss.name+'.'+st.name AS [from],ts.name+'.'+tt.name AS [to],sc.name AS fromColumn,tc.name AS toColumn
      FROM sys.columns sc JOIN sys.tables st ON st.object_id=sc.object_id JOIN sys.schemas ss ON ss.schema_id=st.schema_id
      JOIN sys.columns tc ON tc.name=sc.name JOIN sys.tables tt ON tt.object_id=tc.object_id JOIN sys.schemas ts ON ts.schema_id=tt.schema_id
      JOIN sys.types stype ON stype.user_type_id=sc.user_type_id JOIN sys.types ttype ON ttype.user_type_id=tc.user_type_id AND ttype.system_type_id=stype.system_type_id
      JOIN sys.index_columns ik ON ik.object_id=tc.object_id AND ik.column_id=tc.column_id JOIN sys.indexes ix ON ix.object_id=ik.object_id AND ix.index_id=ik.index_id AND ix.is_primary_key=1
      WHERE st.object_id<>tt.object_id AND ss.name NOT IN ('sys','INFORMATION_SCHEMA') AND ts.name NOT IN ('sys','INFORMATION_SCHEMA')
      AND NOT EXISTS(SELECT 1 FROM sys.index_columns sik JOIN sys.indexes six ON six.object_id=sik.object_id AND six.index_id=sik.index_id AND six.is_primary_key=1 WHERE sik.object_id=sc.object_id AND sik.column_id=sc.column_id)
      ORDER BY [from],[to],fromColumn`);
    for (const candidate of candidates.recordset) {
      if (references.some((item) => item.from === candidate.from && item.fromColumn === candidate.fromColumn && item.to === candidate.to && item.toColumn === candidate.toColumn)) continue;
      const [fromSchema, fromName] = candidate.from.split('.'); const [toSchema, toName] = candidate.to.split('.');
      if (!fromSchema || !fromName || !toSchema || !toName) continue;
      const count = await (await this.request()).query<{ source_count: number; matched_count: number }>(`SELECT COUNT_BIG(src.${quote(candidate.fromColumn)}) AS source_count,COUNT_BIG(dst.${quote(candidate.toColumn)}) AS matched_count
        FROM ${quote(fromSchema)}.${quote(fromName)} src LEFT JOIN ${quote(toSchema)}.${quote(toName)} dst ON src.${quote(candidate.fromColumn)}=dst.${quote(candidate.toColumn)}`);
      const sourceCount = Number(count.recordset[0]?.source_count ?? 0); const matchedCount = Number(count.recordset[0]?.matched_count ?? 0);
      if (sourceCount > 0 && matchedCount / sourceCount >= 0.98) references.push({ ...candidate, evidenceMethod: 'inferred' });
      if (references.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    }
    return references;
  }

  async routines() {
    const rows = await (await this.request()).query<{ qualified_name: string; kind: 'function'|'procedure'; definition: string }>(`SELECT TOP (${this.maxRows + 1}) s.name+'.'+o.name AS qualified_name,CASE WHEN o.type='P' THEN 'procedure' ELSE 'function' END AS kind,COALESCE(OBJECT_DEFINITION(o.object_id),'') AS definition
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY s.name,o.name`);
    if (rows.recordset.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return rows.recordset.map((row) => ({ qualifiedName: row.qualified_name, kind: row.kind, definition: row.definition }));
  }

  async executeQueryIntent(raw: unknown): Promise<{ sql: string; rows: Array<Record<string, unknown>> }> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('analytic_query_intent_invalid');
    const intent = raw as Record<string, unknown>;
    const object = (name: unknown): CatalogObject => { if (typeof name !== 'string') throw new Error('analytic_query_asset_not_found'); const found = this.objects.get(name); if (!found) throw new Error('analytic_query_asset_not_found'); return found; };
    const column = async (target: CatalogObject, name: unknown) => { if (typeof name !== 'string' || !(await this.columns(target)).some((item) => item.column_name === name)) throw new Error('analytic_query_column_not_found'); return quote(name); };
    const aggregate = async (target: CatalogObject, rawAggregate: unknown) => { if (!rawAggregate || typeof rawAggregate !== 'object') throw new Error('analytic_query_intent_invalid'); const spec = rawAggregate as Record<string, unknown>; if (spec.operation === 'count') return 'COUNT_BIG(*)'; if (spec.operation === 'sum') return `COALESCE(SUM(${await column(target, spec.column)}),0)`; throw new Error('analytic_query_intent_invalid'); };
    let query: string; const request = await this.request();
    if (intent.kind === 'count' || intent.kind === 'compare_aggregates') { const target = object(intent.table); const expression = intent.kind === 'count' ? 'COUNT_BIG(*)' : await aggregate(target, intent.aggregate); query = `SELECT TOP (1) ${expression} AS value FROM ${quote(target.schema_name)}.${quote(target.object_name)}`; }
    else if (intent.kind === 'filtered_count') { const target = object(intent.table); const col = await column(target, intent.column); const operator = ({ eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<=' } as Record<string,string>)[String(intent.operator)]; if (!operator || !['string','number','boolean'].includes(typeof intent.value)) throw new Error('analytic_query_intent_invalid'); request.input('filterValue', intent.value as string|number|boolean); query = `SELECT TOP (1) COUNT_BIG(*) AS value FROM ${quote(target.schema_name)}.${quote(target.object_name)} WHERE ${col} ${operator} @filterValue`; }
    else if (intent.kind === 'group_by') { const target = object(intent.table); const group = await column(target, intent.groupBy); query = `SELECT TOP (${this.maxRows}) CAST(${group} AS nvarchar(4000)) AS group_value,${await aggregate(target, intent.aggregate)} AS value FROM ${quote(target.schema_name)}.${quote(target.object_name)} GROUP BY ${group} ORDER BY ${group}`; }
    else if (intent.kind === 'join_aggregate') { const left = object(intent.leftTable); const right = object(intent.rightTable); const lcol = await column(left,intent.leftColumn); const rcol = await column(right,intent.rightColumn); const expr = await aggregate(left,intent.aggregate); query = `SELECT TOP (1) ${expr} AS value FROM ${quote(left.schema_name)}.${quote(left.object_name)} l JOIN ${quote(right.schema_name)}.${quote(right.object_name)} r ON l.${lcol}=r.${rcol}`; }
    else throw new Error('analytic_query_intent_invalid');
    const result = await request.query(query);
    if (result.recordset.length > this.maxRows) throw new Error('sqlserver_connector_result_limit_exceeded');
    return { sql: query, rows: result.recordset as Array<Record<string, unknown>> };
  }

  async queryAggregate(assetKey: string, metric: 'count') { if (metric !== 'count') throw new Error('connector_query_not_supported'); const found = [...this.objects].find(([name]) => keyFor(name) === assetKey); if (!found) throw new Error('asset_not_found'); const object = found[1]; const result = await (await this.request()).query<{ value: number }>(`SELECT TOP (1) COUNT_BIG(*) AS value FROM ${quote(object.schema_name)}.${quote(object.object_name)}`); return { metric: 'count' as const, value: Number(result.recordset[0]?.value ?? 0) }; }
  async close() { if (this.pool.connected) await this.pool.close(); }
}

export function createSqlServerConnector(input: SqlServerConnection & { id?: string; name?: string; statementTimeoutMs?: number; maxRows?: number }) { return new SqlServerConnector(input); }

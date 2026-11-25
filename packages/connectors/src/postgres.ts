import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { classifyColumn } from '@scaleinsyght/classification';
import { COLUMN_STATISTICS_ROW_LIMIT, POSSIBLE_REFERENCE_COVERAGE, UNMEASURED, type ColumnStatistics, type ConnectorScope, type DiscoveryResult, type ObjectProfile, type ReadOnlyConnector } from './index.js';

export type Table = { schema_name: string; table_name: string; table_type: 'BASE TABLE' | 'VIEW' };
type Column = { column_name: string; data_type: string; is_nullable: 'YES' | 'NO'; comment: string | null };
type RoleSafety = {
  elevated: boolean;
  database_write: boolean;
  schema_write: boolean;
  table_write: boolean;
  sequence_write: boolean;
  inherited_roles: boolean;
};
export type PostgresStructuralReference = { from: string; to: string; fromColumn: string; toColumn: string; evidenceMethod?: 'declared'|'inferred'; confidence?:number; matchedCount?:number; sourceCount?:number };
const quoteIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
const POSTGRES_TEXT=new Set(['text','character varying','character']);
const POSTGRES_MEASURABLE=new Set([...POSTGRES_TEXT,'smallint','integer','bigint','numeric','real','double precision','boolean','date','timestamp without time zone','timestamp with time zone','uuid']);
const assetKey=(qualifiedName:string)=>createHash('sha256').update(`postgres\0${qualifiedName}`).digest('hex');

export class PostgresConnector implements ReadOnlyConnector {
  readonly type='postgres' as const;
  readonly modelRequests=0;
  readonly id:string;
  readonly name:string;
  private readonly pool:Pool;
  private readonly maxRows:number;
  private readonly seen=new Map<string,string>();
  private readonly current=new Map<string,Table>();

  constructor(input:{connectionString:string;id?:string;name?:string;statementTimeoutMs?:number;maxRows?:number}){
    const statementTimeoutMs=input.statementTimeoutMs??10_000;
    this.maxRows=input.maxRows??1_000;
    if(!Number.isSafeInteger(statementTimeoutMs)||statementTimeoutMs<1)throw new Error('postgres_statement_timeout_invalid');
    if(!Number.isSafeInteger(this.maxRows)||this.maxRows<1)throw new Error('postgres_row_limit_invalid');
    this.pool=new Pool({connectionString:input.connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:statementTimeoutMs,options:`-c default_transaction_read_only=on -c statement_timeout=${statementTimeoutMs}`});
    this.id=input.id??'postgres-source';this.name=input.name??'PostgreSQL source';
  }

  async test():Promise<{ok:true;capabilities:['discover','profile'];readOnly:true}>{
    const result=await this.pool.query<RoleSafety>(`SELECT
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AS elevated,
      has_database_privilege(current_user,d.oid,'CREATE') AS database_write,
      EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND has_schema_privilege(current_user,n.oid,'CREATE')) AS schema_write,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f') AND (
        has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR
        has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR
        has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER')) ) AS table_write,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind='S' AND (
        has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'UPDATE'))) AS sequence_write,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS inherited_roles
      FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`);
    const role=result.rows[0];if(!role||Object.values(role).some(Boolean))throw new Error('postgres_connector_role_not_read_only');
    await this.pool.query('SELECT 1 FROM information_schema.tables LIMIT 1');
    return {ok:true,capabilities:['discover','profile'],readOnly:true};
  }

  private async tables():Promise<Table[]>{
    const rows=await this.pool.query<Table>(`SELECT table_schema AS schema_name,table_name,
      CASE WHEN table_type='VIEW' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type
      FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type IN ('BASE TABLE','VIEW') ORDER BY table_schema,table_name LIMIT $1`,[this.maxRows+1]);
    if(rows.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    return rows.rows;
  }

  private async columns(table:Table):Promise<Column[]>{
    const result=await this.pool.query<Column>(`SELECT c.column_name,c.data_type,c.is_nullable,
      pg_catalog.col_description(pg_catalog.to_regclass(format('%I.%I',c.table_schema,c.table_name)),c.ordinal_position) AS comment
      FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position LIMIT $3`,[table.schema_name,table.table_name,this.maxRows+1]);
    if(result.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    return result.rows;
  }

  async discover(input:{mode:'profile'|'nightly';scope?:ConnectorScope}):Promise<DiscoveryResult>{
    const tables=await this.tables();this.current.clear();
    const result:DiscoveryResult={objects:[],listOnlyObjects:[],excludedObjects:[],inaccessibleObjects:[],coverage:{listed:0,accessible:0,inaccessible:0},unchanged:0,unchangedObjects:[]};
    const profiles=new Map<string,{table:Table;columns:Column[];key:string}>();
    for(const table of tables){
      const qualifiedName=`${table.schema_name}.${table.table_name}`;this.current.set(qualifiedName,table);result.coverage.listed++;
      const columns=await this.columns(table);const signature=createHash('sha256').update(JSON.stringify(columns.map(({column_name,data_type,is_nullable,comment})=>({column_name,data_type,is_nullable,comment})))).digest('hex');
      const key=assetKey(qualifiedName);profiles.set(qualifiedName,{table,columns,key});result.coverage.accessible++;
      if(input.scope?.exclude?.includes(qualifiedName)){result.excludedObjects.push({qualifiedName,type:table.table_type==='VIEW'?'view':'table'});continue;}
      if(input.scope?.listOnly?.includes(qualifiedName)){result.listOnlyObjects.push({qualifiedName,type:table.table_type==='VIEW'?'view':'table'});continue;}
      if(input.scope?.profile?.length&&!input.scope.profile.includes(qualifiedName)){result.excludedObjects.push({qualifiedName,type:table.table_type==='VIEW'?'view':'table'});continue;}
      const object={assetKey:key,qualifiedName,type:table.table_type==='VIEW'?'view' as const:'table' as const,scopeMode:'profile' as const};
      if(input.mode==='nightly'&&this.seen.get(qualifiedName)===signature){result.unchanged++;result.unchangedObjects.push(object);continue;}
      result.objects.push(object);
    }
    for(const [name,{columns}] of profiles){this.seen.set(name,createHash('sha256').update(JSON.stringify(columns.map(({column_name,data_type,is_nullable,comment})=>({column_name,data_type,is_nullable,comment})))).digest('hex'));}
    return result;
  }

  async profile(key:string,scope?:ConnectorScope):Promise<ObjectProfile>{
    const found=[...this.current.entries()].find(([name])=>assetKey(name)===key);if(!found)throw new Error('asset_not_found');
    const [qualifiedName,table]=found;if(scope?.exclude?.includes(qualifiedName)||scope?.listOnly?.includes(qualifiedName)||(scope?.profile?.length&&!scope.profile.includes(qualifiedName)))throw new Error('object_out_of_scope');
    const columns=await this.columns(table);const count=await this.pool.query<{count:string}>(`SELECT count(*)::text AS count FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`);
    const structural=columns.map(({column_name,data_type,is_nullable,comment})=>({column_name,data_type,is_nullable,comment}));
    // Bounded text samples feed the sensitivity detector only; they are discarded here and never stored or sent to a model (decision 41).
    const sampled=new Map<string,string[]>();
    for(const column of columns)if(['text','character varying','character'].includes(column.data_type)){const rows=await this.pool.query<{v:string}>(`SELECT ${quoteIdentifier(column.column_name)}::text AS v FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)} WHERE ${quoteIdentifier(column.column_name)} IS NOT NULL LIMIT 200`);sampled.set(column.column_name,rows.rows.map(row=>row.v));}
    const rowCount=Number(count.rows[0]!.count);
    const classified=new Map(columns.map(column=>{const declared=column.comment?.match(/sensitivity:([a-z_]+)/g)?.map(tag=>tag.slice('sensitivity:'.length))??[];return [column.column_name,classifyColumn({name:column.column_name,declaredTags:declared,sample:sampled.get(column.column_name)??[]})] as const;}));
    // Null rate, distinct count and average text length on untagged scalar columns, in one aggregate query per table.
    const measurable=rowCount>0&&rowCount<=COLUMN_STATISTICS_ROW_LIMIT?columns.filter(column=>!classified.get(column.column_name)!.tags.length&&POSTGRES_MEASURABLE.has(column.data_type)):[];
    const statistics=new Map<string,ColumnStatistics>();
    if(measurable.length){
      const parts=measurable.flatMap((column,index)=>{const ref=quoteIdentifier(column.column_name);return [`count(${ref}) AS n${index}`,`count(DISTINCT ${ref}) AS d${index}`,POSTGRES_TEXT.has(column.data_type)?`avg(length(${ref}))::float8 AS l${index}`:`NULL::float8 AS l${index}`];});
      const measured=(await this.pool.query<Record<string,string|number|null>>(`SELECT ${parts.join(',')} FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`)).rows[0]!;
      measurable.forEach((column,index)=>statistics.set(column.column_name,{nullRate:1-Number(measured[`n${index}`])/rowCount,distinctCount:Number(measured[`d${index}`]),averageLength:measured[`l${index}`]===null?null:Number(measured[`l${index}`])}));
    }
    return {assetKey:key,qualifiedName,version:createHash('sha256').update(JSON.stringify(structural)).digest('hex'),rowCount,columns:columns.map(column=>{const found=classified.get(column.column_name)!;return {name:column.column_name,dataType:column.data_type,isNullable:column.is_nullable==='YES',sensitivityTags:found.tags,sensitivityEvidence:found.evidence,statistics:statistics.get(column.column_name)??UNMEASURED};})};
  }

  async structuralReferences():Promise<PostgresStructuralReference[]>{
    const result=await this.pool.query<PostgresStructuralReference>(`SELECT local_ns.nspname||'.'||local_table.relname AS "from",target_ns.nspname||'.'||target_table.relname AS "to",
      local_column.attname AS "fromColumn",target_column.attname AS "toColumn"
      FROM pg_constraint fk
      JOIN pg_class local_table ON local_table.oid=fk.conrelid
      JOIN pg_namespace local_ns ON local_ns.oid=local_table.relnamespace
      JOIN pg_class target_table ON target_table.oid=fk.confrelid
      JOIN pg_namespace target_ns ON target_ns.oid=target_table.relnamespace
      JOIN unnest(fk.conkey) WITH ORDINALITY local_key(attnum,position) ON TRUE
      JOIN unnest(fk.confkey) WITH ORDINALITY target_key(attnum,position) ON target_key.position=local_key.position
      JOIN pg_attribute local_column ON local_column.attrelid=fk.conrelid AND local_column.attnum=local_key.attnum
      JOIN pg_attribute target_column ON target_column.attrelid=fk.confrelid AND target_column.attnum=target_key.attnum
      WHERE fk.contype='f' AND local_ns.nspname NOT IN ('pg_catalog','information_schema') AND local_ns.nspname NOT LIKE 'pg_toast%'
      AND EXISTS(SELECT 1 FROM information_schema.tables visible_local WHERE visible_local.table_schema=local_ns.nspname AND visible_local.table_name=local_table.relname)
      AND EXISTS(SELECT 1 FROM information_schema.tables visible_target WHERE visible_target.table_schema=target_ns.nspname AND visible_target.table_name=target_table.relname)
      ORDER BY local_ns.nspname,local_table.relname,local_key.position LIMIT $1`,[this.maxRows+1]);
    if(result.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    const references=result.rows;
    const inferredCandidates=await this.pool.query<{from:string;to:string;fromColumn:string;toColumn:string}>(`SELECT DISTINCT sn.nspname||'.'||st.relname AS "from",tn.nspname||'.'||tt.relname AS "to",sc.column_name AS "fromColumn",tc.column_name AS "toColumn"
      FROM information_schema.columns sc
      JOIN pg_namespace sn ON sn.nspname=sc.table_schema JOIN pg_class st ON st.relnamespace=sn.oid AND st.relname=sc.table_name AND st.relkind IN ('r','p')
      JOIN information_schema.columns tc ON tc.column_name=sc.column_name AND tc.data_type=sc.data_type
      JOIN pg_namespace tn ON tn.nspname=tc.table_schema JOIN pg_class tt ON tt.relnamespace=tn.oid AND tt.relname=tc.table_name AND tt.relkind IN ('r','p')
      JOIN pg_constraint pk ON pk.conrelid=tt.oid AND pk.contype='p'
      JOIN pg_attribute ta ON ta.attrelid=tt.oid AND ta.attname=tc.column_name AND ta.attnum=ANY(pk.conkey)
      WHERE sc.table_schema NOT IN ('pg_catalog','information_schema') AND tc.table_schema NOT IN ('pg_catalog','information_schema')
        AND sc.table_schema NOT LIKE 'pg_toast%' AND tc.table_schema NOT LIKE 'pg_toast%' AND st.oid<>tt.oid
        AND NOT EXISTS(SELECT 1 FROM pg_constraint source_pk
          JOIN LATERAL unnest(source_pk.conkey) source_key(attnum) ON true
          JOIN pg_attribute source_attribute ON source_attribute.attrelid=source_pk.conrelid AND source_attribute.attnum=source_key.attnum
          WHERE source_pk.conrelid=st.oid AND source_pk.contype='p' AND source_attribute.attname=sc.column_name)
      ORDER BY 1,2,3 LIMIT $1`,[this.maxRows]);
    const declared=new Set(references.map(item=>`${item.from}\0${item.fromColumn}\0${item.to}\0${item.toColumn}`));
    for(const candidate of inferredCandidates.rows){
      if(declared.has(`${candidate.from}\0${candidate.fromColumn}\0${candidate.to}\0${candidate.toColumn}`))continue;
      const [fromSchema,fromTable]=candidate.from.split('.');const [toSchema,toTable]=candidate.to.split('.');if(!fromSchema||!fromTable||!toSchema||!toTable)continue;
      const counts=await this.pool.query<{source_count:string;matched_count:string}>(`SELECT count(src.${quoteIdentifier(candidate.fromColumn)})::text AS source_count,count(dst.${quoteIdentifier(candidate.toColumn)})::text AS matched_count FROM ${quoteIdentifier(fromSchema)}.${quoteIdentifier(fromTable)} src LEFT JOIN ${quoteIdentifier(toSchema)}.${quoteIdentifier(toTable)} dst ON src.${quoteIdentifier(candidate.fromColumn)}=dst.${quoteIdentifier(candidate.toColumn)}`);
      const sourceCount=Number(counts.rows[0]?.source_count??0);const matchedCount=Number(counts.rows[0]?.matched_count??0);
      if(sourceCount>0&&matchedCount/sourceCount>=POSSIBLE_REFERENCE_COVERAGE)references.push({...candidate,evidenceMethod:'inferred',confidence:matchedCount/sourceCount,matchedCount,sourceCount});
      if(references.length>=this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    }
    return references;
  }

  async distinctValues(qualifiedName:string,column:string,limit:number):Promise<string[]|null>{
    const table=this.current.get(qualifiedName);if(!table)throw new Error('asset_not_found');
    if(!(await this.columns(table)).some(item=>item.column_name===column))throw new Error('column_not_found');
    const ref=quoteIdentifier(column);
    const result=await this.pool.query<{v:string}>(`SELECT DISTINCT ${ref}::text AS v FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)} WHERE ${ref} IS NOT NULL LIMIT $1`,[limit+1]);
    return result.rows.length>limit?null:result.rows.map(row=>row.v);
  }

  async viewDefinitions():Promise<Array<{qualifiedName:string;schema:string;definition:string|null}>>{
    // With an empty search path, pg_get_viewdef qualifies every table with its schema, so lineage never guesses one.
    const client=await this.pool.connect();let result;
    try{
      await client.query('BEGIN READ ONLY');await client.query("SET LOCAL search_path TO ''");
      result=await client.query<{qualified_name:string;schema_name:string;definition:string|null}>(`SELECT schemaname||'.'||viewname AS qualified_name,schemaname AS schema_name,definition FROM pg_catalog.pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')
        UNION ALL SELECT schemaname||'.'||matviewname,schemaname,definition FROM pg_catalog.pg_matviews ORDER BY 1 LIMIT $1`,[this.maxRows+1]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    if(result.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    return result.rows.map(row=>({qualifiedName:row.qualified_name,schema:row.schema_name,definition:row.definition}));
  }

  async routines():Promise<Array<{qualifiedName:string;kind:'function'|'procedure';definition:string}>>{
    const result=await this.pool.query<{qualified_name:string;kind:'function'|'procedure';definition:string}>(`SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS qualified_name,
      CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END AS kind,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname LIMIT $1`,[this.maxRows+1]);
    if(result.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');
    return result.rows.map(row=>({qualifiedName:row.qualified_name,kind:row.kind,definition:row.definition}));
  }

  async categoryValues(table: string, column: string): Promise<{sql: string; values: string[]} | undefined> {
    const target = this.current.get(table);
    if (!target || !(await this.columns(target)).some(field => field.column_name === column && /^(text|character varying|character)$/.test(field.data_type))) return;
    const key = quoteIdentifier(column);
    const sql = `SELECT DISTINCT ${key} AS value FROM ${quoteIdentifier(target.schema_name)}.${quoteIdentifier(target.table_name)} WHERE ${key} IS NOT NULL ORDER BY value LIMIT 101`;
    const result = await this.pool.query<{value: string}>(sql);
    return {sql, values: result.rows.map(row => row.value)};
  }

  async executeQueryIntent(raw:unknown, includeCellSize=false):Promise<{sql:string;rows:Array<Record<string,unknown>>}>{
    const {sql,values}=await compilePostgresDialectIntent(raw,{table:name=>this.current.get(name),columns:async table=>(await this.columns(table)).map(item=>item.column_name),maxRows:this.maxRows,includeCellSize});
    const result=await this.pool.query(sql,values);if(result.rows.length>this.maxRows)throw new Error('postgres_connector_result_limit_exceeded');return{sql,rows:result.rows as Array<Record<string,unknown>>};
  }

  async queryAggregate(key:string,metric:'count'):Promise<{metric:'count';value:number}>{
    if(metric!=='count')throw new Error('connector_query_not_supported');
    const found=[...this.current.entries()].find(([name])=>assetKey(name)===key);if(!found)throw new Error('asset_not_found');
    const table=found[1];const result=await this.pool.query<{value:string}>(`SELECT count(*)::text AS value FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`);
    return {metric:'count',value:Number(result.rows[0]!.value)};
  }

  async close():Promise<void>{await this.pool.end();}
}

export function createPostgresConnector(input:string|{connectionString:string;id?:string;name?:string;statementTimeoutMs?:number;maxRows?:number},name='PostgreSQL source'):PostgresConnector{
  const config=typeof input==='string'?{connectionString:input,name}:input;
  if(!config.connectionString)throw new Error('postgres_connection_string_required');
  return new PostgresConnector(config);
}

/** Compiles a validated typed intent to PostgreSQL-dialect SQL with bound values. Shared by the PostgreSQL connector and the
 * in-memory DuckDB engine used for workbooks, so both compile identically. Identifiers are checked against the source catalogue. */
export async function compilePostgresDialectIntent(raw:unknown,deps:{table:(name:string)=>Table|undefined;columns:(table:Table)=>Promise<string[]>;maxRows:number;includeCellSize:boolean}):Promise<{sql:string;values:unknown[]}>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('analytic_query_intent_invalid');const intent=raw as Record<string,unknown>;const kind=String(intent.kind);const includeCellSize=deps.includeCellSize;
    const resolve=async(name:unknown):Promise<Table>=>{if(typeof name!=='string'||!/^([A-Za-z_][A-Za-z0-9_$]*\.)?[A-Za-z_][A-Za-z0-9_$]*$/.test(name))throw new Error('analytic_query_asset_not_found');const table=deps.table(name);if(!table)throw new Error('analytic_query_asset_not_found');return table;};
    const column=async(table:Table,name:unknown):Promise<string>=>{if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name))throw new Error('analytic_query_column_not_found');if(!(await deps.columns(table)).includes(name))throw new Error('analytic_query_column_not_found');return quoteIdentifier(name);};
    const aggregate=async(table:Table,value:unknown):Promise<string>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('analytic_query_intent_invalid');const spec=value as Record<string,unknown>;if(spec.operation==='count')return 'count(*)::text';if(spec.operation==='sum')return `coalesce(sum(${await column(table,spec.column)}),0)::text`;throw new Error('analytic_query_intent_invalid');};
    const tableRef=(table:Table)=>`${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`;let sql:string;let values:unknown[]=[];const cellSize=includeCellSize?',count(*) AS cell_size':'';
    const bindFilters=async(filters:unknown,left:Table,right?:Table)=>{if(!Array.isArray(filters))throw new Error('analytic_query_intent_invalid');const clauses:string[]=[];for(const rawFilter of filters){if(!rawFilter||typeof rawFilter!=='object'||Array.isArray(rawFilter))throw new Error('analytic_query_intent_invalid');const filter=rawFilter as Record<string,unknown>;const target=filter.table===undefined?left:filter.table===intent.leftTable||filter.table==='left'?left:filter.table===intent.rightTable||filter.table==='right'?right:undefined;if(!target)throw new Error('analytic_query_intent_invalid');const col=await column(target,filter.column);const alias=target===left?'l':'r';if(filter.operator==='is_not_null'){clauses.push(`${alias}.${col} IS NOT NULL`);continue;}const op=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Record<string,string>)[String(filter.operator)];if(!op||!['string','number','boolean'].includes(typeof filter.value))throw new Error('analytic_query_intent_invalid');values.push(filter.value);clauses.push(`${alias}.${col} ${op} $${values.length}`);}return clauses.length?` WHERE ${clauses.join(' AND ')}`:'';};
    if(kind==='count'||kind==='compare_aggregates'){const table=await resolve(intent.table);const expr=kind==='count'?'count(*)::text':await aggregate(table,intent.aggregate);sql=`SELECT ${expr} AS value${cellSize} FROM ${tableRef(table)}`;}
    else if(kind==='filtered_count'){const table=await resolve(intent.table);const col=await column(table,intent.column);if(intent.operator==='is_not_null')sql=`SELECT count(*)::text AS value${cellSize} FROM ${tableRef(table)} WHERE ${col} IS NOT NULL`;else{const op=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Record<string,string>)[String(intent.operator)];if(!op||!['string','number','boolean'].includes(typeof intent.value))throw new Error('analytic_query_intent_invalid');values=[intent.value];sql=`SELECT count(*)::text AS value${cellSize} FROM ${tableRef(table)} WHERE ${col} ${op} $1`;if(intent.upperExclusive!==undefined){if(intent.operator!=='gte'||typeof intent.upperExclusive!=='string')throw new Error('analytic_query_intent_invalid');values.push(intent.upperExclusive);sql+=` AND ${col} < $2`;}}}
    else if(kind==='group_by'){const table=await resolve(intent.table);const group=await column(table,intent.groupBy);const expr=await aggregate(table,intent.aggregate);const direction=intent.order==='desc'?'DESC':'ASC';const order=intent.orderBy==='value'?`(${expr})::numeric ${direction},${group} ASC`:`${group} ${direction}`;const limit=Math.min(Number(intent.limit)||deps.maxRows,100);sql=`SELECT ${group}::text AS group_value,${expr} AS value${cellSize} FROM ${tableRef(table)} GROUP BY ${group} ORDER BY ${order} LIMIT ${limit}`;}
    else if(kind==='join_aggregate'||kind==='grouped_join'){const left=await resolve(intent.leftTable);const right=await resolve(intent.rightTable);const lc=await column(left,intent.leftColumn);const rc=await column(right,intent.rightColumn);const expr=await aggregate(left,intent.aggregate);const from=` FROM ${tableRef(left)} l JOIN ${tableRef(right)} r ON l.${lc}=r.${rc}`;const where=await bindFilters(intent.filters??[],left,right);if(kind==='join_aggregate')sql=`SELECT ${expr} AS value${cellSize}${from}${where}`;else{const target=intent.groupByTable==='left'?left:right;const alias=intent.groupByTable==='left'?'l':'r';const group=await column(target,intent.groupBy);const key=intent.groupKey?await column(target,intent.groupKey):null;const direction=intent.order==='desc'?'DESC':'ASC';const limit=Math.min(Number(intent.limit)||100,100);sql=`SELECT ${alias}.${group}::text AS group_value,${key?`${alias}.${key}::text AS group_key,`:''}${expr} AS value${cellSize}${from}${where} GROUP BY ${alias}.${group}${key?`,${alias}.${key}`:''} ORDER BY (${expr})::numeric ${direction},${key?`${alias}.${key}`:'group_value'} ASC LIMIT ${limit}`;}}
    else if(kind==='average_count_by'){const table=await resolve(intent.table);const entity=await column(table,intent.entityColumn);const group=await column(table,intent.groupBy);const limit=Math.min(Number(intent.limit)||100,100);sql=`SELECT group_value,avg(entity_count)::text AS value${cellSize} FROM (SELECT ${group} AS group_sort,${group}::text AS group_value,${entity} AS entity_key,count(*) AS entity_count FROM ${tableRef(table)} GROUP BY ${group},${entity}) entity_counts GROUP BY group_sort,group_value ORDER BY group_sort LIMIT ${limit}`;}
    else throw new Error('analytic_query_intent_invalid');
    return {sql,values};
}

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector } from './index.js';

type Table = { schema_name: string; table_name: string; table_type: 'BASE TABLE' | 'VIEW' };
type Column = { column_name: string; data_type: string; is_nullable: 'YES' | 'NO'; comment: string | null };
type RoleSafety = {
  elevated: boolean;
  database_write: boolean;
  schema_write: boolean;
  table_write: boolean;
  sequence_write: boolean;
  inherited_roles: boolean;
};
export type PostgresStructuralReference = { from: string; to: string; fromColumn: string; toColumn: string };
const quoteIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
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
    return {assetKey:key,qualifiedName,version:createHash('sha256').update(JSON.stringify(structural)).digest('hex'),rowCount:Number(count.rows[0]!.count),columns:columns.map(column=>({name:column.column_name,dataType:column.data_type,isNullable:column.is_nullable==='YES',sensitivityTags:column.comment?.includes('sensitivity:identifier')?['identifier']:[],statistics:{nullRate:null,distinctCount:null}}))};
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
    return result.rows;
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

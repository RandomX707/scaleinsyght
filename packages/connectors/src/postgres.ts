import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector } from './index.js';

type Table = { schema_name: string; table_name: string; table_type: 'BASE TABLE' | 'VIEW' };
type Column = { column_name: string; data_type: string; is_nullable: 'YES' | 'NO'; comment: string | null };
export type PostgresStructuralReference = { from: string; to: string; fromColumn: string; toColumn: string };
const quoteIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
const assetKey=(qualifiedName:string)=>createHash('sha256').update(`postgres\0${qualifiedName}`).digest('hex');

export class PostgresConnector implements ReadOnlyConnector {
  readonly type='postgres' as const;
  readonly modelRequests=0;
  readonly id:string;
  readonly name:string;
  private readonly pool:Pool;
  private readonly seen=new Map<string,string>();
  private readonly current=new Map<string,Table>();

  constructor(input:{connectionString:string;id?:string;name?:string}){
    this.pool=new Pool({connectionString:input.connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
    this.id=input.id??'postgres-source';this.name=input.name??'PostgreSQL source';
  }

  async test():Promise<{ok:true;capabilities:['discover','profile'];readOnly:true}>{
    const result=await this.pool.query<{current_user:string;rolsuper:boolean;rolcreatedb:boolean;rolcreaterole:boolean}>('SELECT current_user,r.rolsuper,r.rolcreatedb,r.rolcreaterole FROM pg_roles r WHERE r.rolname=current_user');
    const role=result.rows[0];if(!role||role.rolsuper||role.rolcreatedb||role.rolcreaterole)throw new Error('postgres_connector_role_not_read_only');
    await this.pool.query('SELECT 1 FROM information_schema.tables LIMIT 1');
    return {ok:true,capabilities:['discover','profile'],readOnly:true};
  }

  private async tables():Promise<Table[]>{
    const rows=await this.pool.query<Table>(`SELECT table_schema AS schema_name,table_name,
      CASE WHEN table_type='VIEW' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type
      FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type IN ('BASE TABLE','VIEW') ORDER BY table_schema,table_name`);
    return rows.rows;
  }

  private async columns(table:Table):Promise<Column[]>{
    const result=await this.pool.query<Column>(`SELECT c.column_name,c.data_type,c.is_nullable,
      pg_catalog.col_description(pg_catalog.to_regclass(format('%I.%I',c.table_schema,c.table_name)),c.ordinal_position) AS comment
      FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`,[table.schema_name,table.table_name]);
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
    const result=await this.pool.query<PostgresStructuralReference>(`SELECT tc.table_schema||'.'||tc.table_name AS "from",ccu.table_schema||'.'||ccu.table_name AS "to",kcu.column_name AS "fromColumn",ccu.column_name AS "toColumn"
      FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
        ON tc.constraint_catalog=kcu.constraint_catalog AND tc.constraint_schema=kcu.constraint_schema AND tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_catalog=ccu.constraint_catalog AND tc.constraint_schema=ccu.constraint_schema AND tc.constraint_name=ccu.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY tc.table_schema,tc.table_name,kcu.ordinal_position`);
    return result.rows;
  }

  async close():Promise<void>{await this.pool.end();}
}

export function createPostgresConnector(connectionString:string,name='Local synthetic hospital source'):PostgresConnector{
  if(!connectionString)throw new Error('DATABASE_URL_SAMPLE_SOURCE is required for the real PostgreSQL connector');
  return new PostgresConnector({connectionString,id:'si_sample_source',name});
}

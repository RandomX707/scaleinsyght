import { withTenant, type Pool } from '@scaleinsyght/db';
import type { PoolClient } from 'pg';
import { objectScope, type ControlsPolicy } from '@scaleinsyght/connectors';
import { scopeForConnector, type ScopeRule } from './index.js';

export const defaultControls: ControlsPolicy = {
  groups:{},nameRules:[],columnRules:[],newObjects:'approve',leavingScope:'keep',approval:true,
};

type CatalogObject = { name:string; type:string; inaccessible:boolean };

async function latestCatalog(db:PoolClient, tenantId:string, connectionId:string) {
  const found=await db.query<CatalogObject>(
    `SELECT object_name AS name,object_type AS type,state='INACCESSIBLE' AS inaccessible
       FROM profiler.job_objects WHERE tenant_id=$1 AND job_id=(
         SELECT job_id FROM profiler.jobs WHERE tenant_id=$1 AND connection_id=$2 AND state='COMPLETED'
         ORDER BY created_at DESC LIMIT 1
       ) ORDER BY object_type,object_name`,[tenantId,connectionId]);
  return found.rows;
}

async function lockConnection(db:PoolClient, tenantId:string, connectionId:string) {
  const result=await db.query(
    "SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND status='active' FOR UPDATE",
    [tenantId,connectionId]);
  if(!result.rowCount) throw new Error('connection_not_found');
}

async function requireAdmin(db:PoolClient, tenantId:string, userId:string) {
  const result=await db.query(
    "SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.admin' AND allowed AND resource_id IS NULL",
    [tenantId,userId]);
  if(!result.rowCount) throw new Error('tenant_admin_required');
}

async function current(db:PoolClient, tenantId:string, connectionId:string) {
  const row=(await db.query<{policy:ControlsPolicy&{classification?:unknown};known_objects:string[];revision:number}>(
    'SELECT policy,known_objects,revision FROM registry.connection_controls WHERE tenant_id=$1 AND connection_id=$2',
    [tenantId,connectionId])).rows[0];
  if(!row)return row;
  // Decision 64 removed the "Standard or custom" rules (decision 62). A policy saved with them still loads, without
  // them, so the page can save it again; they were never used for scope.
  const policy={...row.policy};delete policy.classification;
  return {...row,policy:policy as ControlsPolicy};
}

export function getControls(pool:Pool,tenantId:string,connectionId:string) {
  return withTenant(pool,tenantId,async db=>{
    const saved=await current(db,tenantId,connectionId);
    const catalog=await latestCatalog(db,tenantId,connectionId);
    const overrides=(await db.query<ScopeRule>(
      `SELECT qualified_name AS "qualifiedName",object_type AS "objectType",scope_mode AS "scopeMode"
       FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 ORDER BY qualified_name`,[tenantId,connectionId])).rows;
    const scope=saved ? {...scopeForConnector(overrides),policy:saved.policy,knownObjects:new Set(saved.known_objects)} : scopeForConnector(overrides);
    const estimate=(await db.query<{ms:number}>(
      `SELECT extract(epoch FROM updated_at-created_at)::float8*1000 AS ms FROM profiler.jobs
       WHERE tenant_id=$1 AND connection_id=$2 AND state='COMPLETED' AND job_type='nightly' ORDER BY created_at DESC LIMIT 1`,
      [tenantId,connectionId])).rows[0]?.ms??null;
    return {policy:saved?.policy??defaultControls,revision:saved?.revision??0,overrides,nightlyEstimateMs:estimate,
      objects:catalog.map(item=>({...item,mode:item.inaccessible?'exclude':objectScope(scope,item.name,item.type)}))};
  });
}

async function apply(db:PoolClient,tenantId:string,connectionId:string,revision:number,policy:ControlsPolicy,overrides:ScopeRule[],known:string[]) {
  await db.query(
    `INSERT INTO registry.connection_controls(tenant_id,connection_id,revision,policy,known_objects)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,connection_id)
     DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,known_objects=EXCLUDED.known_objects`,
    [tenantId,connectionId,revision,JSON.stringify(policy),known]);
  await db.query('DELETE FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);
  await db.query(
    `INSERT INTO registry.connection_scopes(tenant_id,connection_id,qualified_name,object_type,scope_mode)
     SELECT $1,$2,o."qualifiedName",o."objectType",o."scopeMode"
     FROM jsonb_to_recordset($3::jsonb) AS o("qualifiedName" text,"objectType" text,"scopeMode" text)`,
    [tenantId,connectionId,JSON.stringify(overrides)]);
}

export function saveControls(pool:Pool,input:{tenantId:string;userId:string;connectionId:string;revision:number;policy:ControlsPolicy;overrides:ScopeRule[]}) {
  const {tenantId,userId,connectionId,revision,policy,overrides}=input;
  return withTenant(pool,tenantId,async db=>{
    await requireAdmin(db,tenantId,userId);
    await lockConnection(db,tenantId,connectionId);
    const previous=await current(db,tenantId,connectionId);
    if((previous?.revision??0)!==revision)throw new Error('controls_revision_conflict');
    const catalog=await latestCatalog(db,tenantId,connectionId);
    const names=new Set(catalog.map(item=>item.name));
    if(overrides.some(item=>!names.has(item.qualifiedName)))throw new Error('invalid_scope');
    const known=previous?.known_objects??[...names];
    if((previous?.policy.approval??true)||policy.approval){
      const result=await db.query<{change_id:string}>(
        `INSERT INTO registry.control_changes(tenant_id,connection_id,base_revision,proposed_by,policy,overrides,known_objects)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING change_id`,
        [tenantId,connectionId,revision,userId,JSON.stringify(policy),JSON.stringify(overrides),known]);
      return {status:'pending',changeId:result.rows[0]!.change_id};
    }
    await apply(db,tenantId,connectionId,revision+1,policy,overrides,known);
    return {status:'applied'};
  });
}

export function listControlChanges(pool:Pool,tenantId:string) {
  return withTenant(pool,tenantId,async db=>(await db.query(
    `SELECT p.change_id AS "changeId",c.display_name AS "connectionName",p.status,p.proposed_at AS "proposedAt",p.policy,p.overrides,
       ARRAY(SELECT name FROM unnest(p.known_objects) AS name WHERE NOT name=ANY(COALESCE(applied.known_objects,ARRAY[]::text[]))) AS "newObjects"

     FROM registry.control_changes p JOIN registry.connections c USING(tenant_id,connection_id)
     LEFT JOIN registry.connection_controls applied USING(tenant_id,connection_id)
     WHERE p.tenant_id=$1 ORDER BY p.proposed_at DESC LIMIT 100`,[tenantId])).rows);
}

export function decideControlChange(pool:Pool,input:{tenantId:string;userId:string;changeId:string;decision:'approved'|'rejected'}) {
  const {tenantId,userId,changeId,decision}=input;
  return withTenant(pool,tenantId,async db=>{
    await requireAdmin(db,tenantId,userId);
    const change=(await db.query<{connection_id:string;base_revision:number;policy:ControlsPolicy;overrides:ScopeRule[];known_objects:string[];status:string}>(
      'SELECT * FROM registry.control_changes WHERE tenant_id=$1 AND change_id=$2 FOR UPDATE',[tenantId,changeId])).rows[0];
    if(!change||change.status!=='pending')throw new Error('control_change_not_pending');
    await lockConnection(db,tenantId,change.connection_id);
    if(decision==='approved'){
      const previous=await current(db,tenantId,change.connection_id);
      if((previous?.revision??0)!==change.base_revision)throw new Error('controls_revision_conflict');
      await apply(db,tenantId,change.connection_id,change.base_revision+1,change.policy,change.overrides,change.known_objects);
    }
    await db.query('UPDATE registry.control_changes SET status=$3,decided_by=$4,decided_at=clock_timestamp() WHERE tenant_id=$1 AND change_id=$2',
      [tenantId,changeId,decision,userId]);
    return {status:decision};
  });
}

/** New objects stay list only while the proposal is pending. Approval accepts their names into the policy baseline. */
export function queueNewObjectReview(pool:Pool,tenantId:string,connectionId:string,names:string[]) {
  if(!names.length)return;
  return withTenant(pool,tenantId,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`controls:${connectionId}`]);
    const saved=await current(db,tenantId,connectionId);
    if(saved?.policy.newObjects!=='approve')return;
    const known=new Set(saved.known_objects);
    const newNames=[...new Set(names)].filter(name=>!known.has(name)).sort();
    if(!newNames.length)return;
    const next=[...known,...newNames].sort();
    const existing=await db.query(
      `SELECT 1 FROM registry.control_changes WHERE tenant_id=$1 AND connection_id=$2 AND base_revision=$3
       AND known_objects=$4 AND proposed_by IS NULL AND status IN ('pending','rejected')`,
      [tenantId,connectionId,saved.revision,next]);
    if(existing.rowCount)return;
    await db.query(
      `INSERT INTO registry.control_changes(tenant_id,connection_id,base_revision,policy,overrides,known_objects)
       SELECT $1,$2,$3,$4,COALESCE(jsonb_agg(jsonb_build_object('qualifiedName',qualified_name,
         'objectType',object_type,'scopeMode',scope_mode)),'[]'::jsonb),$5
       FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2`,
      [tenantId,connectionId,saved.revision,JSON.stringify(saved.policy),next]);
  });
}

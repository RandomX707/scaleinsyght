import type { MigrationBuilder } from 'node-pg-migrate';

// Agents become real at execution time (decision 52).
// - Connector agents carry explicit capabilities. Versions are immutable (contract 2), so an agent whose active version
//   lists none gets a new version with ["analytic.read","profile.read"], made active, with an agent_version_activated
//   event; the old version stays as it was.
// - Each tenant has one ID agent and one ID trace agent; their runs are logged as agent_run events.
// - Authorization decisions record the agent that acted.
// The backfill must see every tenant, but tables force row-level security even for their owner, so this migration's
// role gets read and write policies for the duration of the migration transaction only; they are dropped at the end.
const CONNECTOR_CAPABILITIES = '["analytic.read","profile.read"]';
const ID_CAPABILITIES = '["id.detect","id.fingerprint","id.match"]';
const ID_TRACE_CAPABILITIES = '["id.trace","id.lookup"]';
const touched = ['core.tenants', 'registry.agents', 'registry.agent_versions', 'registry.events'];

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE runs.authz_decisions ADD COLUMN agent_id uuid;
    ALTER TABLE runs.authz_decisions ADD CONSTRAINT authz_decisions_agent_fkey FOREIGN KEY (tenant_id,agent_id) REFERENCES registry.agents(tenant_id,agent_id);
    ALTER TABLE registry.events DROP CONSTRAINT events_event_type_check;
    ALTER TABLE registry.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN ('agent_created','agent_retired','agent_version_activated','agent_run'));
    CREATE UNIQUE INDEX registry_agents_one_per_tenant ON registry.agents(tenant_id,agent_type) WHERE agent_type IN ('id','id_trace');
    ${touched.map((table, index) => `CREATE POLICY migration_backfill_${index} ON ${table} FOR ALL TO si_migrate USING (true) WITH CHECK (true);`).join('\n    ')}

    WITH stale AS (
      SELECT a.tenant_id,a.agent_id,a.active_version,v.bindings,(SELECT max(version) FROM registry.agent_versions m WHERE m.tenant_id=a.tenant_id AND m.agent_id=a.agent_id) AS latest
      FROM registry.agents a JOIN registry.agent_versions v ON v.tenant_id=a.tenant_id AND v.agent_id=a.agent_id AND v.version=a.active_version
      WHERE a.agent_type='connector' AND v.capabilities='[]'::jsonb),
    added AS (
      INSERT INTO registry.agent_versions(tenant_id,agent_id,version,capabilities,bindings,status)
      SELECT tenant_id,agent_id,latest+1,'${CONNECTOR_CAPABILITIES}'::jsonb,bindings,'approved' FROM stale RETURNING tenant_id,agent_id,version),
    switched AS (
      UPDATE registry.agents a SET active_version=added.version FROM added WHERE a.tenant_id=added.tenant_id AND a.agent_id=added.agent_id RETURNING a.tenant_id,a.agent_id,a.connection_id,added.version)
    INSERT INTO registry.events(tenant_id,event_type,agent_id,connection_id,safe_payload)
      SELECT tenant_id,'agent_version_activated',agent_id,connection_id,jsonb_build_object('version',version,'reason','explicit_capabilities') FROM switched;

    WITH created AS (
      INSERT INTO registry.agents(tenant_id,agent_type,active_version,status)
      SELECT t.tenant_id,kind.agent_type,1,'active' FROM core.tenants t CROSS JOIN (VALUES ('id'),('id_trace')) AS kind(agent_type)
      ON CONFLICT DO NOTHING RETURNING tenant_id,agent_id,agent_type),
    versions AS (
      INSERT INTO registry.agent_versions(tenant_id,agent_id,version,capabilities,bindings,status)
      SELECT tenant_id,agent_id,1,CASE agent_type WHEN 'id' THEN '${ID_CAPABILITIES}'::jsonb ELSE '${ID_TRACE_CAPABILITIES}'::jsonb END,'{}'::jsonb,'approved' FROM created RETURNING tenant_id)
    INSERT INTO registry.events(tenant_id,event_type,agent_id,safe_payload)
      SELECT tenant_id,'agent_created',agent_id,jsonb_build_object('agent_type',agent_type) FROM created;

    ${touched.map((table, index) => `DROP POLICY migration_backfill_${index} ON ${table};`).join('\n    ')}
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP INDEX registry.registry_agents_one_per_tenant;
    ALTER TABLE registry.events DROP CONSTRAINT events_event_type_check;
    ALTER TABLE registry.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN ('agent_created','agent_retired'));
    ALTER TABLE runs.authz_decisions DROP CONSTRAINT authz_decisions_agent_fkey;
    ALTER TABLE runs.authz_decisions DROP COLUMN agent_id;
  `);
}

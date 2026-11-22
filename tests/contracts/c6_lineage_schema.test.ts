import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';

config({ path: '.env' });
const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error('DATABASE_URL_MIGRATE is required; PostgreSQL contract tests are never skipped');
const testUrl = new URL(url);
testUrl.pathname = '/si_test';
const pool = new Pool({ connectionString: testUrl.toString() });

describe('c6 lineage and identifier schema contracts', () => {
  afterAll(async () => pool.end());

  it('c1_phase3_graph_tables_are_tenant_scoped_and_forced_rls', async () => {
    const result = await pool.query<{ table_name: string; rls: boolean; forced: boolean; has_tenant: boolean }>(
      `SELECT c.relname AS table_name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
       EXISTS(SELECT 1 FROM information_schema.columns x WHERE x.table_schema='graph' AND x.table_name=c.relname AND x.column_name='tenant_id') AS has_tenant
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='graph' AND c.relname IN ('id_fields','id_fingerprints','id_path_steps','snapshots','events') ORDER BY c.relname`,
    );
    expect(result.rows).toHaveLength(5);
    for (const row of result.rows) expect(row).toMatchObject({ rls: true, forced: true, has_tenant: true });
  });

  it('c6_assertions_expose_temporal_validity_and_graph_events_are_append_only', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='graph' AND table_name='assertions'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
    const trigger = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers WHERE event_object_schema='graph' AND event_object_table='events'`,
    );
    expect(trigger.rows.map((row) => row.trigger_name)).toContain('graph_events_immutable');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = `phase3-event-${crypto.randomUUID()}`;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO graph.events(tenant_id,event_type,safe_payload) VALUES($1,'metadata_imported','{"fixture":"phase3"}') RETURNING event_id`,
        [tenantId],
      );
      await expect(client.query('UPDATE graph.events SET safe_payload=$1 WHERE tenant_id=$2 AND event_id=$3', [{ changed: true }, tenantId, inserted.rows[0]!.event_id])).rejects.toThrow('graph events are immutable');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

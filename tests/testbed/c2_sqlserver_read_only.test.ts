import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createSqlServerConnector } from '@scaleinsyght/connectors';
import { createDisposableSqlServerWriter } from '../support/sqlserver-writer.js';

config({ path: resolve('.env') });
const required = ['SQLSERVER_TESTBED_HOST','SQLSERVER_TESTBED_PORT','SQLSERVER_TESTBED_DATABASE','SQLSERVER_TESTBED_USERNAME','SQLSERVER_TESTBED_PASSWORD'] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`${missing.join(', ')} required; run pnpm testbed:sqlserver:up. SQL Server contract tests are never skipped.`);
const connector = createSqlServerConnector({
  server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
  username: process.env.SQLSERVER_TESTBED_USERNAME!, password: process.env.SQLSERVER_TESTBED_PASSWORD!, encrypt: true, trustServerCertificate: true,
  statementTimeoutMs: 10_000, maxRows: 1_000,
});

describe('SQL Server connector read-only contract', () => {
  beforeAll(async () => { await connector.discover({ mode: 'profile' }); });
  afterAll(async () => { await connector.close(); });
  it('sqlserver_connector_rejects_effective_write_permissions', async () => {
    await expect(connector.test()).resolves.toMatchObject({ ok: true, readOnly: true });
    const writerCredential = createDisposableSqlServerWriter();
    const writer = createSqlServerConnector({
      server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
      username: writerCredential.username, password: writerCredential.password, encrypt: true, trustServerCertificate: true,
    });
    try { await expect(writer.test()).rejects.toThrow('sqlserver_connector_role_not_read_only'); }
    finally {
      await writer.close();
      writerCredential.remove();
    }
  });
  it('sqlserver_catalog_discovery_includes_views_and_routines', async () => {
    const catalog = await connector.discover({ mode: 'profile' });
    expect(catalog.objects.map((item) => item.qualifiedName)).toContain('dbo.patient_encounter_summary');
    expect((await connector.routines?.())?.map((item) => item.qualifiedName)).toContain('dbo.count_patient_encounters');
  });
  it('sqlserver_structural_references_label_declared_and_inferred', async () => {
    const refs = await connector.structuralReferences?.();
    expect(refs).toContainEqual(expect.objectContaining({ from: 'dbo.orders', to: 'dbo.encounters', evidenceMethod: 'declared' }));
    expect(refs).toContainEqual(expect.objectContaining({ from: 'dbo.encounters', to: 'dbo.patients', evidenceMethod: 'inferred' }));
  });
  it('sqlserver_connector_limits_query_time_and_rows', async () => {
    const catalog = await connector.discover({ mode: 'profile' });
    const patients = catalog.objects.find((item) => item.qualifiedName === 'dbo.patients');
    expect(patients).toBeDefined();
    expect((await connector.queryAggregate?.(patients!.assetKey, 'count'))?.value).toBe(500);
    await expect(connector.executeQueryIntent?.({ kind: 'filtered_count', table: 'dbo.patients', column: 'patient_id', operator: 'gte', value: 1 })).resolves.toMatchObject({ rows: [{ value: '500' }] });
    const capped = createSqlServerConnector({
      server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
      username: process.env.SQLSERVER_TESTBED_USERNAME!, password: process.env.SQLSERVER_TESTBED_PASSWORD!, encrypt: true, trustServerCertificate: true,
      statementTimeoutMs: 10_000, maxRows: 2,
    });
    try { await expect(capped.discover({ mode: 'profile' })).rejects.toThrow('sqlserver_connector_result_limit_exceeded'); }
    finally { await capped.close(); }
  });
});

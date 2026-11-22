import { describe, expect, it } from 'vitest';
import { createGoldenConnector } from '@scaleinsyght/connectors';

describe('synthetic read-only connectors', () => {
  it('c6_golden_500_table_schema_harvests_within_ten_minutes_without_model_calls', async () => {
    const connector = createGoldenConnector('golden-sqlserver');
    const started = performance.now();
    const result = await connector.discover({ mode: 'profile' });
    expect(performance.now() - started).toBeLessThan(600_000);
    expect(result.objects).toHaveLength(499);
    expect(result.coverage).toEqual({ listed: 500, accessible: 499, inaccessible: 1 });
    expect(result.inaccessibleObjects).toEqual([{ qualifiedName: 'X_Restricted.Internal_Audit', type: 'table' }]);
    expect(connector.modelRequests).toBe(0);
  });

  it('c6_identical_source_profiles_produce_identical_versions', async () => {
    const a = createGoldenConnector('golden-postgres');
    const b = createGoldenConnector('golden-postgres');
    const object = (await a.discover({ mode: 'profile' })).objects[0]!;
    const first = await a.profile(object.assetKey);
    const second = await b.profile(object.assetKey);
    expect(first).toEqual(second);
  });

  it('c6_nightly_refresh_skips_unchanged_objects_and_profiles_only_changes', async () => {
    const connector = createGoldenConnector('golden-sqlserver');
    const result = await connector.discover({ mode: 'nightly' });
    expect(result.objects.map((object) => object.qualifiedName)).toEqual(['X_Golden.Table_042']);
    expect(result.unchanged).toBe(498);
  });

  it('phase1_excel_sheets_are_read_only_table_assets', async () => {
    const connector = createGoldenConnector('golden-excel');
    const result = await connector.discover({ mode: 'profile' });
    expect(result.objects.map((object) => object.type)).toEqual(['table', 'table', 'table']);
    expect(result.objects.map((object) => object.qualifiedName)).toContain('Riverside workbook.Departments');
  });

  it('phase1_scope_controls_prevent_out_of_scope_discovery_and_query', async () => {
    const connector = createGoldenConnector('golden-postgres');
    const all = await connector.discover({ mode: 'profile' });
    const profiled = all.objects[2]!;
    const listOnly = all.objects[0]!;
    const excluded = all.objects[1]!;
    const result = await connector.discover({
      mode: 'profile',
      scope: { profile: [profiled.qualifiedName], listOnly: [listOnly.qualifiedName], exclude: [excluded.qualifiedName] },
    });
    expect(result.objects.map((object) => object.qualifiedName)).toEqual([profiled.qualifiedName]);
    expect(result.listOnlyObjects.map((object) => object.qualifiedName)).toContain(listOnly.qualifiedName);
    expect(result.excludedObjects.map((object) => object.qualifiedName)).toContain(excluded.qualifiedName);
    await expect(connector.profile(excluded.assetKey, { exclude: [excluded.qualifiedName] })).rejects.toThrow('object_out_of_scope');
    await expect(connector.profile(listOnly.assetKey, { listOnly: [listOnly.qualifiedName] })).rejects.toThrow('object_out_of_scope');
  });
});

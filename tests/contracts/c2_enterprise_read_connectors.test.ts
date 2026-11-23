import { describe, expect, it } from 'vitest';
import { createCrmConnector, createLakeConnector } from '@scaleinsyght/connectors';

describe('contract 2 generic enterprise read connectors', () => {
  it('c2_lake_and_crm_read_connectors_obey_shared_read_only_contract', async () => {
    for (const connector of [createLakeConnector(), createCrmConnector()]) {
      await expect(connector.test()).resolves.toEqual({ ok: true, capabilities: ['discover', 'profile'], readOnly: true });
      const first = await connector.discover({ mode: 'profile' });
      const second = await connector.discover({ mode: 'profile' });
      expect(first.objects.length).toBeGreaterThan(0);
      expect(first.objects.map((asset) => asset.assetKey)).toEqual(second.objects.map((asset) => asset.assetKey));
      const profile = await connector.profile(first.objects[0]!.assetKey);
      expect(profile.qualifiedName).toBe(first.objects[0]!.qualifiedName);
      expect(await connector.queryAggregate?.(first.objects[0]!.assetKey, 'count')).toMatchObject({ metric: 'count', value: expect.any(Number) });
      expect(connector).not.toHaveProperty('insert');
      expect(connector).not.toHaveProperty('update');
      expect(connector).not.toHaveProperty('delete');
      expect(connector).not.toHaveProperty('execute');
    }
  });
});

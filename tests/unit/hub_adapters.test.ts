import { describe, expect, it } from 'vitest';
import { createGoldenHubAdapters, getGoldenHubFixtures } from '@scaleinsyght/hub-adapters';

describe('synthetic Scale Data Hub adapters', () => {
  it('hub_semantics_adapter_returns_certified_metric_and_safe_evidence', async () => {
    const { semantics } = createGoldenHubAdapters(getGoldenHubFixtures());
    const result = await semantics.queryCertifiedMetric('active_customers');

    expect(result).toMatchObject({ metricId: 'active_customers', value: 1284, unit: 'customers', certified: true });
    expect(result.evidence).toMatchObject({ kind: 'api_call', adapter: 'semantics', fixtureKey: 'active-customers-v1' });
    expect(result).not.toHaveProperty('rows');
    expect(result).not.toHaveProperty('compiledSql');
  });

  it('hub_semantics_adapter_rejects_unknown_metric_ids', async () => {
    const { semantics } = createGoldenHubAdapters(getGoldenHubFixtures());
    await expect(semantics.queryCertifiedMetric('caller-supplied-sql')).rejects.toThrow('unknown_certified_metric');
  });

  it('hub_disconnected_adapters_refuse_operations_without_fallback', async () => {
    const { semantics } = createGoldenHubAdapters(getGoldenHubFixtures(), { connectedProducts: [] });
    await expect(semantics.queryCertifiedMetric('active_customers')).rejects.toThrow('hub_adapter_disconnected');
  });

  it('data_studio_handoff_is_idempotent_and_reconcilable_by_key', async () => {
    const { dataStudio } = createGoldenHubAdapters(getGoldenHubFixtures());
    const flowspec = { flowspecId: 'flow-synthetic-1', version: 1, payloadHash: 'a'.repeat(64) };

    const first = await dataStudio.deliverFlowSpec('handoff-key-1', flowspec);
    const repeated = await dataStudio.deliverFlowSpec('handoff-key-1', flowspec);
    const reconciled = await dataStudio.lookupFlowSpec('handoff-key-1');

    expect(repeated).toEqual(first);
    expect(reconciled).toEqual(first);
    expect(first.status).toBe('accepted');
  });

  it('data_studio_rejects_reusing_a_key_for_a_different_flowspec', async () => {
    const { dataStudio } = createGoldenHubAdapters(getGoldenHubFixtures());
    await dataStudio.deliverFlowSpec('handoff-key-1', { flowspecId: 'flow-synthetic-1', version: 1, payloadHash: 'a'.repeat(64) });
    await expect(dataStudio.deliverFlowSpec('handoff-key-1', { flowspecId: 'flow-synthetic-1', version: 2, payloadHash: 'b'.repeat(64) }))
      .rejects.toThrow('idempotency_key_payload_conflict');
  });
});

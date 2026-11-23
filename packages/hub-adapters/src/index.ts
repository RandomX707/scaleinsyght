import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type HubProduct = 'data_studio' | 'semantics';

export interface GoldenHubFixture {
  tenant: { id: string; name: string };
  adapters: Array<{
    product: HubProduct;
    version: number;
    fixtureKey: string;
    connected: boolean;
    capabilities: string[];
  }>;
  metrics: Array<{
    id: string;
    name: string;
    description: string;
    dimensions: string[];
    unit: string;
    value: number;
    certified: boolean;
    fixtureKey: string;
    sourceAsset: string;
  }>;
  dataStudio: { accepted: boolean };
}

export interface SemanticMetricResult {
  metricId: string;
  name: string;
  value: number;
  unit: string;
  certified: true;
  adapterVersion: number;
  evidence: {
    kind: 'api_call';
    adapter: 'semantics';
    adapterVersion: number;
    fixtureKey: string;
    contentHash: string;
    sourceAsset: string;
  };
}

export interface FlowSpecDelivery {
  flowspecId: string;
  version: number;
  payloadHash: string;
}

export interface FlowSpecReceipt extends FlowSpecDelivery {
  idempotencyKey: string;
  status: 'accepted';
}

export interface SemanticsAdapter {
  readonly product: 'semantics';
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly connected: boolean;
  listCertifiedMetrics(): Array<Omit<GoldenHubFixture['metrics'][number], 'value' | 'fixtureKey'>>;
  queryCertifiedMetric(metricId: string): Promise<SemanticMetricResult>;
}

export interface DataStudioAdapter {
  readonly product: 'data_studio';
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly connected: boolean;
  deliverFlowSpec(idempotencyKey: string, flowSpec: FlowSpecDelivery): Promise<FlowSpecReceipt>;
  lookupFlowSpec(idempotencyKey: string): Promise<FlowSpecReceipt | null>;
}

export function getGoldenHubFixtures(): GoldenHubFixture {
  return JSON.parse(readFileSync(new URL('../../../tests/golden/phase4.json', import.meta.url), 'utf8')) as GoldenHubFixture;
}

export function createGoldenHubAdapters(
  fixture: GoldenHubFixture,
  options: { connectedProducts?: HubProduct[] } = {},
): { semantics: SemanticsAdapter; dataStudio: DataStudioAdapter } {
  const enabled = new Set(options.connectedProducts ?? fixture.adapters.filter((item) => item.connected).map((item) => item.product));
  const semanticsInfo = fixture.adapters.find((item) => item.product === 'semantics');
  const studioInfo = fixture.adapters.find((item) => item.product === 'data_studio');
  if (!semanticsInfo || !studioInfo) throw new Error('hub_adapter_fixture_invalid');

  const semanticAdapter: SemanticsAdapter = {
    product: 'semantics', version: semanticsInfo.version, capabilities: semanticsInfo.capabilities,
    get connected() { return enabled.has('semantics'); },
    listCertifiedMetrics: () => fixture.metrics
      .filter((metric) => metric.certified)
      .map(({ value: _value, fixtureKey: _fixtureKey, ...metric }) => structuredClone(metric)),
    async queryCertifiedMetric(metricId) {
      if (!enabled.has('semantics')) throw new Error('hub_adapter_disconnected');
      const metric = fixture.metrics.find((item) => item.id === metricId && item.certified);
      if (!metric) throw new Error('unknown_certified_metric');
      const contentHash = createHash('sha256').update(JSON.stringify({
        adapter: 'semantics', version: semanticsInfo.version, fixtureKey: metric.fixtureKey,
        metricId: metric.id, value: metric.value, unit: metric.unit,
      })).digest('hex');
      return {
        metricId: metric.id, name: metric.name, value: metric.value, unit: metric.unit,
        certified: true, adapterVersion: semanticsInfo.version,
        evidence: {
          kind: 'api_call', adapter: 'semantics', adapterVersion: semanticsInfo.version,
          fixtureKey: metric.fixtureKey, contentHash, sourceAsset: metric.sourceAsset,
        },
      };
    },
  };

  const receipts = new Map<string, FlowSpecReceipt>();
  const dataStudioAdapter: DataStudioAdapter = {
    product: 'data_studio', version: studioInfo.version, capabilities: studioInfo.capabilities,
    get connected() { return enabled.has('data_studio'); },
    async deliverFlowSpec(idempotencyKey, flowSpec) {
      if (!enabled.has('data_studio')) throw new Error('hub_adapter_disconnected');
      if (!idempotencyKey.trim() || !/^[a-f0-9]{64}$/.test(flowSpec.payloadHash)) throw new Error('invalid_flowspec_delivery');
      const prior = receipts.get(idempotencyKey);
      if (prior) {
        if (prior.payloadHash !== flowSpec.payloadHash || prior.flowspecId !== flowSpec.flowspecId || prior.version !== flowSpec.version) {
          throw new Error('idempotency_key_payload_conflict');
        }
        return structuredClone(prior);
      }
      if (!fixture.dataStudio.accepted) throw new Error('data_studio_rejected_flowspec');
      const receipt: FlowSpecReceipt = { ...structuredClone(flowSpec), idempotencyKey, status: 'accepted' };
      receipts.set(idempotencyKey, receipt);
      return structuredClone(receipt);
    },
    async lookupFlowSpec(idempotencyKey) {
      if (!enabled.has('data_studio')) throw new Error('hub_adapter_disconnected');
      const receipt = receipts.get(idempotencyKey);
      return receipt ? structuredClone(receipt) : null;
    },
  };

  return { semantics: semanticAdapter, dataStudio: dataStudioAdapter };
}

export type HubProduct = 'data_studio' | 'semantics';

export interface SemanticMetricDefinition {
  id: string;
  name: string;
  description: string;
  dimensions: string[];
  unit: string;
  certified: boolean;
  sourceAsset: string;
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
  receiverRef: string;
  status: 'accepted';
}

export interface SemanticsAdapter {
  readonly product: 'semantics';
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly connected: boolean;
  listCertifiedMetrics(): SemanticMetricDefinition[];
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

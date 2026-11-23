import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AnalyticPlanSchema } from '@scaleinsyght/contracts';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function createEnrollment(input: { tenantId: string; now?: number; ttlSeconds?: number }) {
  if (!input.tenantId) throw new Error('gateway_tenant_required');
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: digest(token), expiresAt: (input.now ?? Date.now()) + (input.ttlSeconds ?? 300) * 1000 };
}

export async function createGatewayCredential() {
  const credential = randomBytes(32).toString('hex');
  return { credential, credentialHash: digest(credential) };
}

export function hashGatewaySecret(value: string): string { return digest(value); }

export function claimRequest(input: { requestId: string; tenantId: string; now: number; leaseMs: number; attempt: number }) {
  if (!input.requestId || !input.tenantId || input.leaseMs <= 0 || input.attempt < 1) throw new Error('gateway_claim_invalid');
  return { requestId: input.requestId, tenantId: input.tenantId, fencingToken: randomUUID(), leaseExpiresAt: input.now + input.leaseMs, attempt: input.attempt };
}

export interface GatewayResult { requestId: string; fencingToken: string; aggregates: Array<{ metric: string; value: number; unit?: string }> }

export function validateGatewayResult(value: unknown): GatewayResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('gateway_result_invalid');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== 'aggregates,fencingToken,requestId' || typeof result.requestId !== 'string' || typeof result.fencingToken !== 'string' || !Array.isArray(result.aggregates) || result.aggregates.length > 1000) throw new Error('gateway_result_invalid');
  for (const item of result.aggregates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('gateway_result_invalid');
    const aggregate = item as Record<string, unknown>;
    const keys = Object.keys(aggregate).sort().join(',');
    if ((keys !== 'metric,value' && keys !== 'metric,unit,value') || typeof aggregate.metric !== 'string' || aggregate.metric.length > 128 || typeof aggregate.value !== 'number' || !Number.isFinite(aggregate.value) || ('unit' in aggregate && (typeof aggregate.unit !== 'string' || aggregate.unit.length > 32))) throw new Error('gateway_result_invalid');
  }
  return result as unknown as GatewayResult;
}

export function createOutboundClient(input: { baseUrl: string; credential: string; fetcher?: typeof fetch }) {
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'https:') throw new Error('gateway_https_required');
  const fetcher = input.fetcher ?? fetch;
  return {
    async poll() {
      const response = await fetcher(new URL('/api/gateways/poll', base), { method: 'POST', headers: { authorization: `Bearer ${input.credential}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('gateway_poll_failed');
      return await response.json() as { request: unknown | null };
    },
    async processNext(execute: (plan: ReturnType<typeof AnalyticPlanSchema.parse>) => Promise<GatewayResult['aggregates']>) {
      const polled = await this.poll() as { request: null | { requestId: string; fencingToken: string; plan: unknown } };
      if (!polled.request) return { status: 'empty' as const };
      const plan = AnalyticPlanSchema.parse(polled.request.plan);
      if (plan.steps.some((step) => step.effect_class !== 'READ' || 'sql' in step.inputs)) throw new Error('gateway_plan_rejected');
      const aggregates = await execute(plan);
      const result = validateGatewayResult({ requestId: polled.request.requestId, fencingToken: polled.request.fencingToken, aggregates });
      const response = await fetcher(new URL(`/api/gateways/results/${encodeURIComponent(result.requestId)}`, base), { method: 'POST', headers: { authorization: `Bearer ${input.credential}`, 'content-type': 'application/json' }, body: JSON.stringify(result), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('gateway_result_submission_failed');
      return await response.json() as { status: string };
    },
  };
}

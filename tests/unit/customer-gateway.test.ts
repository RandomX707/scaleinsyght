import { describe, expect, it, vi } from 'vitest';
import { createEnrollment, claimRequest, validateGatewayResult, createOutboundClient } from '@scaleinsyght/customer-gateway';
import { createAnalyticPlan } from '@scaleinsyght/analytic';
import { randomUUID } from 'node:crypto';

describe('customer gateway protocol', () => {
  it('creates one-use enrollment values as hashes only', async () => {
    const enrollment = await createEnrollment({ tenantId: 'tenant-a', now: 1_000, ttlSeconds: 60 });
    expect(enrollment.token).toHaveLength(64);
    expect(enrollment.tokenHash).not.toBe(enrollment.token);
    expect(enrollment.expiresAt).toBe(61_000);
  });

  it('fences concurrent request claims and rejects stale leases', () => {
    const first = claimRequest({ requestId: 'request-a', tenantId: 'tenant-a', now: 100, leaseMs: 1000, attempt: 1 });
    const stale = claimRequest({ requestId: 'request-a', tenantId: 'tenant-a', now: 100, leaseMs: 1000, attempt: 1 });
    expect(first.fencingToken).not.toBe(stale.fencingToken);
  });

  it('accepts only bounded aggregate results without identifying values', () => {
    const valid = { requestId: 'request-a', fencingToken: 'fence', aggregates: [{ metric: 'count', value: 12 }] };
    expect(validateGatewayResult(valid)).toEqual(valid);
    expect(() => validateGatewayResult({ ...valid, rows: [{ patient_id: 'raw' }] })).toThrow('gateway_result_invalid');
    expect(() => validateGatewayResult({ ...valid, aggregates: Array.from({ length: 1001 }, () => valid.aggregates[0]) })).toThrow('gateway_result_invalid');
  });

  it('uses outbound polling without opening an inbound listener', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request: null }), { status: 200 }));
    const client = createOutboundClient({ baseUrl: 'https://control.example', credential: 'secret', fetcher });
    await expect(client.poll()).resolves.toEqual({ request: null });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://control.example/api/gateways/poll');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(client).not.toHaveProperty('listen');
  });

  it('validates a read plan and returns only the aggregate envelope over outbound HTTPS', async () => {
    const sourceId=randomUUID();
    const plan=await createAnalyticPlan({question:'Count synthetic rows',runId:randomUUID(),sources:[{sourceId,agentId:randomUUID(),groupId:randomUUID(),groupVersion:1}]});
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({request:{requestId:'request-a',fencingToken:'fence',plan}}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({status:'completed'}),{status:200}));
    const client = createOutboundClient({baseUrl:'https://control.example',credential:'synthetic-credential',fetcher});
    const execute = vi.fn().mockResolvedValue([{metric:'row_count',value:8}]);
    await expect(client.processNext(execute)).resolves.toEqual({status:'completed'});
    expect(execute).toHaveBeenCalledOnce();
    const body=JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Record<string,unknown>;
    expect(body).toEqual({requestId:'request-a',fencingToken:'fence',aggregates:[{metric:'row_count',value:8}]});
    expect(fetcher.mock.calls[1]?.[0]).toBeInstanceOf(URL);
  });
});

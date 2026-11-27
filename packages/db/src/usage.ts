import type { Pool } from 'pg';
import { withTenant } from './index.js';

export interface UsageRecord {
  tenant_id: string;
  period: { from: string; to: string };
  active_users: number;
  active_connectors: { by_type: Record<string, number> };
  computed_from_event_ids_range: { first: string | null; last: string | null };
  /** The plan's allowances (decision 71): users is null when the plan sets none; connectors counts every active connection. */
  allowance: { users: number | null; connectors: number };
  model_usage: { input_tokens:number;output_tokens:number;cost_usd:number;daily_cost_cap_usd:number|null;daily_user_cost_cap_usd:number|null;today_cost_usd:number;today_user_cost_usd:number|null };
}

export async function getUsage(
  pool: Pool,
  tenantId: string,
  from: Date,
  to: Date,
  /** Daily model caps in USD and, when given, the person whose own spend today is reported. */
  budget?: { tenantUsd: number; userUsd: number; principalId?: string },
): Promise<UsageRecord> {
  if (!(from instanceof Date) || Number.isNaN(from.valueOf()) || !(to instanceof Date) || Number.isNaN(to.valueOf())) {
    throw new Error('Usage period bounds must be valid dates');
  }
  if (from >= to) throw new Error('Usage period start must be earlier than its end');

  return withTenant(pool, tenantId, async (client) => {
    const users = await client.query<{ count: string }>(
      `SELECT count(DISTINCT principal_id)::text AS count
       FROM core.activity_events
       WHERE tenant_id = $1 AND event_type = 'user_active'
         AND occurred_at >= $2 AND occurred_at < $3 AND principal_id IS NOT NULL`,
      [tenantId, from, to],
    );
    const connectors = await client.query<{ connector_type: string; count: string }>(
      `WITH latest_connector_state AS (
         SELECT DISTINCT ON (connector_id) connector_id, connector_type, event_type
         FROM core.activity_events
         WHERE tenant_id = $1 AND connector_id IS NOT NULL AND occurred_at < $2
         ORDER BY connector_id, occurred_at DESC, event_id DESC
       )
       SELECT connector_type, count(*)::text AS count
       FROM latest_connector_state
       WHERE event_type = 'connector_activated'
       GROUP BY connector_type ORDER BY connector_type`,
      [tenantId, to],
    );
    const range = await client.query<{ first: string | null; last: string | null }>(
      `SELECT min(event_id::text) AS first, max(event_id::text) AS last
       FROM core.activity_events WHERE tenant_id = $1 AND occurred_at < $2`,
      [tenantId, to],
    );
    const plan = await client.query<{ user_allowance: number | null; connector_allowance: number }>('SELECT user_allowance, connector_allowance FROM core.tenants WHERE tenant_id = $1', [tenantId]);
    const modelUsage=await client.query<{input_tokens:string;output_tokens:string;cost_usd:string}>(
      `SELECT COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens,COALESCE(sum(cost_usd),0)::text AS cost_usd
       FROM core.model_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,[tenantId,from,to]);
    const dayStart=new Date();dayStart.setUTCHours(0,0,0,0);const dayEnd=new Date(dayStart.getTime()+86_400_000);
    const today=await client.query<{tenant_cost:string;user_cost:string}>(
      `SELECT COALESCE(sum(cost_usd),0)::text AS tenant_cost,COALESCE(sum(cost_usd) FILTER (WHERE principal_id=$4),0)::text AS user_cost
       FROM core.model_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,[tenantId,dayStart,dayEnd,budget?.principalId??null]);

    return {
      tenant_id: tenantId,
      period: { from: from.toISOString(), to: to.toISOString() },
      active_users: Number(users.rows[0]?.count ?? 0),
      active_connectors: { by_type: Object.fromEntries(connectors.rows.map((row) => [row.connector_type, Number(row.count)])) },
      computed_from_event_ids_range: { first: range.rows[0]?.first ?? null, last: range.rows[0]?.last ?? null },
      allowance: { users: plan.rows[0]?.user_allowance ?? null, connectors: plan.rows[0]?.connector_allowance ?? 0 },
      model_usage:{input_tokens:Number(modelUsage.rows[0]?.input_tokens??0),output_tokens:Number(modelUsage.rows[0]?.output_tokens??0),cost_usd:Number(modelUsage.rows[0]?.cost_usd??0),daily_cost_cap_usd:budget?.tenantUsd??null,daily_user_cost_cap_usd:budget?.userUsd??null,today_cost_usd:Number(today.rows[0]?.tenant_cost??0),today_user_cost_usd:budget?.principalId?Number(today.rows[0]?.user_cost??0):null},
    };
  });
}

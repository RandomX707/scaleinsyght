import type { Pool } from 'pg';
import { withTenant } from './index.js';

export interface UsageRecord {
  tenant_id: string;
  period: { from: string; to: string };
  active_users: number;
  active_connectors: { by_type: Record<string, number> };
  computed_from_event_ids_range: { first: string | null; last: string | null };
}

export async function getUsage(
  pool: Pool,
  tenantId: string,
  from: Date,
  to: Date,
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

    return {
      tenant_id: tenantId,
      period: { from: from.toISOString(), to: to.toISOString() },
      active_users: Number(users.rows[0]?.count ?? 0),
      active_connectors: { by_type: Object.fromEntries(connectors.rows.map((row) => [row.connector_type, Number(row.count)])) },
      computed_from_event_ids_range: { first: range.rows[0]?.first ?? null, last: range.rows[0]?.last ?? null },
    };
  });
}

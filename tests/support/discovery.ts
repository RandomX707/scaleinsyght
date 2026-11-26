import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import type { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { connectorForConnection, runNextDiscovery } from '@scaleinsyght/profiler';
import { testConnectorFor } from './test-api.js';

config({ path: '.env' });

/**
 * Runs every queued discovery job of one tenant to the end, as the worker would (decision 57). Activation only queues
 * the profile now; tests without a running worker call this after activating. Test sources resolve through the test
 * API's connectors and real ones through their stored credentials. A job that does not complete fails the test.
 */
export async function runQueuedDiscoveries(tenantId: string, artifactStore?: EncryptedArtifactStore): Promise<void> {
  const value = process.env.DATABASE_URL_WORKER; if (!value) throw new Error('DATABASE_URL_WORKER is required to run queued discovery jobs');
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const connectorFor = async (tenant: string, connectionId: string) => {
      const ref = await withTenant(pool, tenant, (client) => client.query<{ source_ref: string | null }>('SELECT source_ref FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [tenant, connectionId]));
      const sourceRef = ref.rows[0]?.source_ref;
      const injected = sourceRef ? testConnectorFor(sourceRef) : null;
      // A test source's connector belongs to the test server, which keeps using it; the job must not close it.
      if (injected) return new Proxy(injected, { get: (target, key) => key === 'close' ? async () => undefined : (() => { const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value; })() });
      return connectorForConnection(pool, tenant, connectionId, artifactStore);
    };
    while (await runNextDiscovery(pool, connectorFor, tenantId)) { /* until none is queued */ }
    const unfinished = await withTenant(pool, tenantId, (client) => client.query<{ state: string; failure_code: string | null }>(
      "SELECT state,failure_code FROM profiler.jobs WHERE tenant_id=$1 AND job_type='discovery' AND state<>'COMPLETED'", [tenantId]));
    if (unfinished.rowCount) throw new Error(`discovery did not complete: ${JSON.stringify(unfinished.rows)}`);
  } finally { await pool.end(); }
}

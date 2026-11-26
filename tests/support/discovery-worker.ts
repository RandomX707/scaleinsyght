import { config } from 'dotenv';
import { Pool } from 'pg';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runNextDiscovery } from '@scaleinsyght/profiler';
import { createGoldenConnector, listGoldenSources } from './golden-connectors.js';

// A real worker process for one tenant's discovery jobs (bug 6 test). The parent kills it with SIGKILL partway
// through a profile, then starts it again; it must claim the job once the lease has run out and finish the profile.
// Each object's profile is slowed so there is time to kill it mid-profile. DISCOVERY_LEASE_MS is set by the parent.
config({ path: '.env' });
const [tenantId, pauseMs] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL_WORKER!); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
const pool = new Pool({ connectionString: url.toString() });
const source = listGoldenSources().find((item) => item.type === 'postgres')!;
const slow = (): ReadOnlyConnector => {
  const inner = createGoldenConnector(source.id);
  return new Proxy(inner, { get: (target, key) => key === 'profile'
    ? async (...args: Parameters<ReadOnlyConnector['profile']>) => { await new Promise((resolve) => setTimeout(resolve, Number(pauseMs))); return target.profile(...args); }
    : (() => { const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value; })() });
};
const ran = await runNextDiscovery(pool, async () => slow(), tenantId);
process.stdout.write(`${JSON.stringify({ ran })}\n`);
await pool.end();

import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createPostgresConnector } from '@scaleinsyght/connectors';

// A source that closes idle connections (restart, failover, a dropped database) must not crash the API or worker:
// the connector's pool absorbs the error and the next call reconnects.
config({ path: '.env' });

describe('contract 2 PostgreSQL connector resilience', () => {
  it('c2_postgres_connector_survives_the_source_closing_idle_connections', async () => {
    const source = process.env.DATABASE_URL_SAMPLE_SOURCE; if (!source) throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; run pnpm db:setup:sample');
    // Terminating another session needs the local administrator, as pnpm db:setup uses.
    const adminUrl = process.env.DATABASE_URL_ADMIN ?? (() => { const url = new URL('postgresql://127.0.0.1:5432/postgres'); url.username = userInfo().username; return url.toString(); })();
    const connector = createPostgresConnector({ connectionString: source, id: 'resilience', name: 'Resilience source' });
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await expect(connector.test()).resolves.toMatchObject({ readOnly: true });
      const user = decodeURIComponent(new URL(source).username);
      const terminated = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()', [user]);
      expect(terminated.rowCount).toBeGreaterThan(0);
      await delay(200);
      await expect(connector.test()).resolves.toMatchObject({ readOnly: true });
    } finally { await connector.close?.(); await admin.end(); }
  });
});

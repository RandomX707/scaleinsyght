import { Pool, type PoolClient, type PoolConfig } from 'pg';

export { Pool };
export type { PoolClient };
export type DatabaseUrlKey = 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE';

export function databaseUrl(key: DatabaseUrlKey): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; set it in .env before starting the application or tests`);
  return value;
}

export function createPool(key: DatabaseUrlKey = 'DATABASE_URL', config: Omit<PoolConfig, 'connectionString'> = {}): Pool {
  const pool = new Pool({
    connectionString: databaseUrl(key),
    max: 10,
    connectionTimeoutMillis: 5_000,
    ...config,
  });
  pool.on('error', (error: Error) => {
    console.error(`PostgreSQL connection error using ${key}; check ${key} and ensure PostgreSQL 16 is running: ${error.message}`);
  });
  return pool;
}

export async function verifyDatabaseConnection(pool: Pool, key: DatabaseUrlKey): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`PostgreSQL is unreachable using ${key}; check ${key} and ensure PostgreSQL 16 is running. ${reason}`);
  }
}

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!tenantId.trim()) throw new Error('tenantId must be non-empty');
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('RESET app.tenant_id');
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await operation(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface StoredRunContext {
  tenant_id: string;
  run_id: string;
  principal_id: string;
}

export async function withRunTenant<T>(
  pool: Pool,
  runId: string,
  operation: (client: PoolClient, run: StoredRunContext) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('RESET app.tenant_id');
    await client.query('RESET app.worker_run_lookup');
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SELECT set_config('app.worker_run_lookup', $1, true)", [runId]);
    const lookup = await client.query<StoredRunContext>(
      'SELECT tenant_id, run_id, principal_id FROM runs.runs WHERE run_id = $1',
      [runId],
    );
    const storedRun = lookup.rows[0];
    if (!storedRun) throw new Error('Run does not exist or is not available to the worker');
    await client.query("SELECT set_config('app.worker_run_lookup', '', true)");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [storedRun.tenant_id]);
    const value = await operation(client, storedRun);
    await client.query('COMMIT');
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { getUsage, type UsageRecord } from './usage.js';

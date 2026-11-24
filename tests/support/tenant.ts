import type { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';

export function provisionTestTenant(pool: Pool, input: { tenantId: string; email: string; displayName: string; password: string }) {
  return createTenant(pool, { ...input, name: input.tenantId });
}

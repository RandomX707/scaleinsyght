import 'dotenv/config';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createPostgresConnector } from '@scaleinsyght/connectors';

it('excludes a real testbed table before any column or row count query', async () => {
  const connectionString = process.env.DATABASE_URL_TESTBED;
  if (!connectionString) throw new Error('DATABASE_URL_TESTBED is required');
  const connector = createPostgresConnector({connectionString});
  const {pool} = connector as unknown as {pool:Pool};
  const queries = vi.spyOn(pool,'query');
  try {
    const result = await connector.discover({mode:'nightly',scope:{exclude:['public.patients']}});
    expect(result.excludedObjects).toContainEqual({qualifiedName:'public.patients',type:'table'});
    expect(queries.mock.calls.some(args=>String(args[0]).includes('"public"."patients"'))).toBe(false);
    expect(queries.mock.calls.some(args=>Array.isArray(args[1]) && args[1][0]==='public' && args[1][1]==='patients')).toBe(false);
    expect(result.objects.length+result.unchangedObjects.length).toBeGreaterThan(0);
  } finally {
    queries.mockRestore();
    await connector.close();
  }
});

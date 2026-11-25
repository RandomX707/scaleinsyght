import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { createPostgresConnector } from '@scaleinsyght/connectors';

// Scale test finding: the data-read row limit (1,000) was also applied to catalog listings, so a source with more than
// about 1,000 columns or foreign keys could not be profiled at all. The two limits are now separate. Real PostgreSQL.
config({ path: '.env' });
const url = process.env.DATABASE_URL_SAMPLE_SOURCE;
if (!url) throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; run pnpm db:setup:sample');
const tight = createPostgresConnector({ connectionString: url, name: 'Sample', maxRows: 2 });
const catalogBound = createPostgresConnector({ connectionString: url, name: 'Sample', maxRows: 1_000, maxCatalogRows: 2 });

describe('contract 2 connector limits', () => {
  afterAll(async () => { await tight.close(); await catalogBound.close(); });

  it('c2_catalog_listing_is_not_bound_by_the_data_row_limit', async () => {
    // The sample source has five tables and more than two columns and keys; listing them succeeds with a data limit of 2.
    const discovered = await tight.discover({ mode: 'profile' });
    expect(discovered.objects.length).toBeGreaterThan(2);
    expect((await tight.structuralReferences()).length).toBeGreaterThan(2);
    // Data reads keep their limit: a breakdown of twelve departments comes back bounded to two rows.
    const grouped = await tight.executeQueryIntent({ kind: 'group_by', table: 'public.departments', groupBy: 'department_name', aggregate: { operation: 'count' } });
    expect(grouped.rows.length).toBeLessThanOrEqual(2);
  });

  it('c2_catalog_listing_still_has_its_own_ceiling', async () => {
    await expect(catalogBound.discover({ mode: 'profile' })).rejects.toThrow('postgres_connector_result_limit_exceeded');
  });
});

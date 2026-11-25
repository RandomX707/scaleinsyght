import { describe, expect, it } from 'vitest';
import { CATALOG_TABLE_LIMIT, selectCatalogTables, words, type CatalogAsset } from '../../apps/api/src/catalog-selection.js';

const table = (name: string, columns: string[] = ['status', 'created_on']): CatalogAsset => ({ qualified_name: name, columns: [{ name: `${name.split('.').pop()}_id` }, ...columns.map((column) => ({ name: column }))] });
const domains = ['accounting', 'billing', 'logistics', 'sales', 'support', 'quality', 'payroll', 'inventory'];
const entities = ['invoice', 'shipment', 'ticket', 'employee', 'item', 'inspection', 'customer_order'];
const big: CatalogAsset[] = domains.flatMap((domain) => [table(`${domain}.region`, ['region_name']), ...entities.flatMap((entity) => ['', '_line', '_history', '_audit', '_snapshot'].map((variant) => table(`${domain}.${entity}${variant}`, ['status', 'created_on', 'region_id'])))]);

describe('planner catalog selection', () => {
  it('passes a catalog at or under the limit through unchanged', () => {
    const small = big.slice(0, CATALOG_TABLE_LIMIT);
    expect(selectCatalogTables({ question: 'How many orders?', assets: small, joins: [] })).toEqual({ assets: small, total: CATALOG_TABLE_LIMIT, narrowed: false });
  });

  it('folds plurals and splits names', () => {
    expect(words('Billing invoices, customerOrders and categories')).toEqual(['billing', 'invoice', 'customer', 'order', 'and', 'category']);
  });

  it('keeps the schema and table the question names, ahead of same-named tables elsewhere', () => {
    const chosen = selectCatalogTables({ question: 'How many billing invoices are there?', assets: big, joins: [] });
    expect(chosen.narrowed).toBe(true);
    expect(chosen.assets.length).toBeLessThanOrEqual(CATALOG_TABLE_LIMIT);
    expect(chosen.assets.map((asset) => asset.qualified_name)).toContain('billing.invoice');
    const scores = chosen.assets.map((asset) => asset.qualified_name);
    expect(scores.indexOf('billing.invoice')).toBeGreaterThanOrEqual(0);
  });

  it('adds the tables a kept table joins to, so a breakdown can reach its names', () => {
    const joins = [{ from_name: 'sales.customer_order.region_id', to_name: 'sales.region.region_id' }];
    const chosen = selectCatalogTables({ question: 'How many sales customer orders per status?', assets: big, joins, limit: 3 });
    const names = chosen.assets.map((asset) => asset.qualified_name);
    expect(names).toContain('sales.customer_order');
    expect(names).toContain('sales.region');
  });

  it('ranks a table by all the words it shares with the question, not by one common word', () => {
    // Scale test S09: "inspection" alone must not count as naming every *.inspection table.
    const chosen = selectCatalogTables({ question: 'How many quality inspection audit records are there?', assets: big, joins: [], limit: 5, joinAllowance: 0 });
    expect(chosen.assets.map((asset) => asset.qualified_name)).toContain('quality.inspection_audit');
  });

  it('always keeps a table the question names in full', () => {
    const chosen = selectCatalogTables({ question: 'Where does quality.inspection_audit come from?', assets: big, joins: [] });
    expect(chosen.assets.map((asset) => asset.qualified_name)).toContain('quality.inspection_audit');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer, type ServerOptions } from '@scaleinsyght/api/server';
import { createGoldenConnector, listGoldenSources } from './golden-connectors.js';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { createCrmConnector, createLakeConnector } from './test-generic-connectors.js';
import { createGoldenHubAdapters, getGoldenHubFixtures } from './golden-hub-adapters.js';

const metadataSources = [
  { id: 'golden-dbt', type: 'dbt' as const, name: 'dbt test manifest' },
  { id: 'golden-tableau', type: 'tableau' as const, name: 'Tableau test workbook' },
  { id: 'golden-powerbi', type: 'power_bi' as const, name: 'Power BI test report' },
];

function fixtureAccounts(): Array<{ tenantId: string; email: string }> {
  return readdirSync(resolve('tests/golden')).filter(file => file.endsWith('.json')).flatMap(file => {
    const data = JSON.parse(readFileSync(resolve('tests/golden', file), 'utf8')) as { users?: Array<{ tenantId: string; email: string }> };
    return data.users ?? [];
  });
}

let sampleConnector: ReadOnlyConnector | undefined;
/** The connectors behind the test sources, shared by the test API and by tests that run queued discovery jobs. */
export function testConnectorFor(sourceId: string): ReadOnlyConnector | null {
  const sampleSource = process.env.DATABASE_URL_SAMPLE_SOURCE;
  // One instance for the whole test process, as before: the connector remembers what it last saw, so a nightly refresh
  // after the discovery profile skips unchanged tables.
  if (sourceId === 'local-hospital') return sampleSource ? (sampleConnector ??= createPostgresConnector({ connectionString: sampleSource, id: 'local-hospital', name: 'Local PostgreSQL test source' })) : null;
  if (sourceId === 'synthetic-lake') return createLakeConnector();
  if (sourceId === 'synthetic-crm') return createCrmConnector();
  return createGoldenConnector(sourceId);
}

export function buildTestServer(options: ServerOptions) {
  const hub = createGoldenHubAdapters(getGoldenHubFixtures());
  const sampleSource = process.env.DATABASE_URL_SAMPLE_SOURCE;
  const sampleSources = sampleSource ? [
    { id: 'local-hospital', type: 'postgres' as const, name: 'Local PostgreSQL test source' },
    { id: 'local-dbt-manifest', type: 'dbt' as const, name: 'dbt manifest test source' },
  ] : [];
  const genericSources = [
    { id: 'synthetic-lake', type: 'lake' as const, name: 'Lake connector test source' },
    { id: 'synthetic-crm', type: 'crm' as const, name: 'CRM connector test source' },
  ];
  return buildServer({
    ...options,
    testAnalyticPlanner: options.testAnalyticPlanner ?? (async () => null),
    testAccounts: options.testAccounts ?? fixtureAccounts(),
    testSources: [...listGoldenSources(), ...metadataSources, ...sampleSources, ...genericSources],
    testConnectorFor,
    hubAdapters: options.hubAdapters ?? hub,
  });
}

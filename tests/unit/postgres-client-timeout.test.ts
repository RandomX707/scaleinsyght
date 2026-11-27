import { expect, it } from 'vitest';
import { createPostgresConnector } from '@scaleinsyght/connectors';
import { startStalledPostgres } from '../support/stalled-postgres.js';

it('bounds a PostgreSQL query when the source accepts startup and never answers the query', async () => {
  const source = await startStalledPostgres();
  const connector = createPostgresConnector({
    connectionString: source.url,
    statementTimeoutMs: 75,
  });
  const watchdog = setTimeout(source.disconnect, 1_000);
  try {
    const started = performance.now();
    await expect(connector.test()).rejects.toMatchObject({ code: 'SOURCE_QUERY_TIMEOUT' });
    expect(source.querySeen()).toBe(true);
    expect(performance.now() - started).toBeLessThan(750);
  } finally {
    clearTimeout(watchdog);
    source.disconnect();
    await connector.close();
    await source.close();
  }
});

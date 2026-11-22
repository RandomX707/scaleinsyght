import { resolve } from 'node:path';
import { config } from 'dotenv';
import { runner } from 'node-pg-migrate';

config({ path: resolve(process.cwd(), '.env') });

const databaseUrl = process.env.DATABASE_URL_MIGRATE;
if (!databaseUrl) {
  throw new Error('DATABASE_URL_MIGRATE is required; run pnpm db:setup first.');
}
if (process.argv.includes('--test')) {
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = '/si_test';
  await migrate(testUrl.toString());
} else {
  await migrate(databaseUrl);
}

async function migrate(url: string): Promise<void> {
  await runner({
    databaseUrl: url,
    dir: resolve(process.cwd(), 'packages/db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    singleTransaction: true,
    verbose: true,
  });
}

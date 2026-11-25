import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({path:'.env'});
const database=new URL(process.env.DATABASE_URL??'');database.pathname='/si_test';
const workerDatabase=new URL(process.env.DATABASE_URL_WORKER??'');workerDatabase.pathname='/si_test';
const apiPort=Number(process.env.TESTBED_API_PORT??3320);
const workerPort=Number(process.env.TESTBED_WORKER_PORT??3321);
const webPort=Number(process.env.TESTBED_WEB_PORT??4284);
const parserPort=Number(process.env.TESTBED_SQLPARSE_PORT??8021);
export default defineConfig({testDir:'./tests/e2e',testMatch:'real-product-s*.spec.ts',fullyParallel:false,workers:1,timeout:180_000,expect:{timeout:20_000},outputDir:'docs/acceptance/testbed/test-output',use:{baseURL:`http://127.0.0.1:${webPort}`,browserName:'chromium',actionTimeout:20_000,video:'on',screenshot:'only-on-failure'},webServer:[
  {command:`SQLPARSE_PORT=${parserPort} node scripts/sqlparse-dev.mjs`,url:`http://127.0.0.1:${parserPort}/health`,reuseExistingServer:false},
  {command:`SQLPARSE_URL=http://127.0.0.1:${parserPort} API_PORT=${apiPort} PUBLIC_APP_URL=http://127.0.0.1:${webPort} pnpm exec tsx scripts/testbed-api-main.ts`,url:`http://127.0.0.1:${apiPort}/api/health`,reuseExistingServer:false},
  {command:`SQLPARSE_URL=http://127.0.0.1:${parserPort} WORKER_HEALTH_PORT=${workerPort} pnpm exec tsx scripts/testbed-worker-main.ts`,url:`http://127.0.0.1:${workerPort}/health`,reuseExistingServer:false},
  {command:`API_PROXY_TARGET=http://127.0.0.1:${apiPort} pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port ${webPort}`,url:`http://127.0.0.1:${webPort}`,reuseExistingServer:false},
]});

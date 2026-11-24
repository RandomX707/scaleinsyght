import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({path:'.env'});
const database=new URL(process.env.DATABASE_URL??'');database.pathname='/si_test';
const workerDatabase=new URL(process.env.DATABASE_URL_WORKER??'');workerDatabase.pathname='/si_test';
const apiPort=3310;const workerPort=3311;const webPort=4184;
export default defineConfig({testDir:'./tests/e2e',testMatch:'real-product-s1.spec.ts',fullyParallel:false,workers:1,timeout:180_000,expect:{timeout:20_000},outputDir:'docs/acceptance/s1/test-output',use:{baseURL:`http://127.0.0.1:${webPort}`,browserName:'chromium',video:'on',screenshot:'only-on-failure'},webServer:[
  {command:'pnpm exec tsx scripts/testbed-api-main.ts',url:`http://127.0.0.1:${apiPort}/api/health`,reuseExistingServer:false},
  {command:'pnpm exec tsx scripts/testbed-worker-main.ts',url:`http://127.0.0.1:${workerPort}/health`,reuseExistingServer:false},
  {command:`API_PROXY_TARGET=http://127.0.0.1:${apiPort} pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port ${webPort}`,url:`http://127.0.0.1:${webPort}`,reuseExistingServer:false},
]});

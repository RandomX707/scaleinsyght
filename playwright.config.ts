import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({path:'.env'});
const appUrl=new URL(process.env.DATABASE_URL??'');appUrl.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;
const workerUrl=new URL(process.env.DATABASE_URL_WORKER??'');workerUrl.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;
const e2eApiPort=Number(process.env.E2E_API_PORT??3300);
const e2eWorkerHealthPort=Number(process.env.E2E_WORKER_PORT??3301);
const e2eWebPort=Number(process.env.E2E_WEB_PORT??4174);
export default defineConfig({
 testDir:'./tests/e2e',
 testIgnore:['real-product-s*.spec.ts'],
 use:{baseURL:`http://127.0.0.1:${e2eWebPort}`,browserName:'chromium'},
 webServer:[
  {command:'pnpm exec tsx tests/support/e2e-api-main.ts',url:`http://127.0.0.1:${e2eApiPort}/api/health`,reuseExistingServer:false,env:{DATABASE_URL:appUrl.toString(),API_PORT:String(e2eApiPort)}},
  {command:'pnpm exec tsx tests/support/e2e-worker.ts',url:`http://127.0.0.1:${e2eWorkerHealthPort}/health`,reuseExistingServer:false,env:{DATABASE_URL_WORKER:workerUrl.toString(),WORKER_HEALTH_PORT:String(e2eWorkerHealthPort)}},
  {command:`pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port ${e2eWebPort}`,url:`http://127.0.0.1:${e2eWebPort}`,reuseExistingServer:false,env:{API_PROXY_TARGET:`http://127.0.0.1:${e2eApiPort}`}},
 ],
});

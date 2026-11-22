import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({path:'.env'});
const appUrl=new URL(process.env.DATABASE_URL??'');appUrl.pathname='/si_test';
const workerUrl=new URL(process.env.DATABASE_URL_WORKER??'');workerUrl.pathname='/si_test';
export default defineConfig({
 testDir:'./tests/e2e',
 use:{baseURL:'http://127.0.0.1:4173',browserName:'chromium'},
 webServer:[
  {command:'pnpm --filter @scaleinsyght/api dev',url:'http://127.0.0.1:3000/api/health',reuseExistingServer:!process.env.CI,env:{DATABASE_URL:appUrl.toString()}},
  {command:'pnpm --filter @scaleinsyght/worker dev',url:'http://127.0.0.1:3001/health',reuseExistingServer:!process.env.CI,env:{DATABASE_URL_WORKER:workerUrl.toString()}},
  {command:'pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port 4173',url:'http://127.0.0.1:4173',reuseExistingServer:!process.env.CI},
 ],
});

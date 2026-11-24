import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: { __DEMO_MODE__: JSON.stringify(env.DEMO_MODE === 'true' || process.env.DEMO_MODE === 'true') },
    server: { proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' } },
  };
});

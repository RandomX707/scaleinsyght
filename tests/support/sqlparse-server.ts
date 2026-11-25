import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Starts the real SQLGlot service (services/sqlparse) for a test on its own port and points SQLPARSE_URL at it. */
export async function startSqlParser(port = Number(process.env.SQLPARSE_TEST_PORT ?? 8031)): Promise<{ url: string; stop: () => void }> {
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('node', [resolve('scripts/sqlparse-dev.mjs')], { env: { ...process.env, SQLPARSE_PORT: String(port) }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    await delay(250);
    if (attempt === 59) { child.kill(); throw new Error('The SQL parser service did not start; create .venv and install services/sqlparse/requirements.txt'); }
  }
  process.env.SQLPARSE_URL = url;
  return { url, stop: () => { child.kill(); } };
}

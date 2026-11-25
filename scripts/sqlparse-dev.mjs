import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.platform === 'win32' ? join(root,'.venv','Scripts','python.exe') : join(root,'.venv','bin','python');
const child = spawn(python,['-m','uvicorn','services.sqlparse.app:app','--host','127.0.0.1','--port',process.env.SQLPARSE_PORT??'8011'],{cwd:root,stdio:'inherit'});
child.on('error',()=>{console.error('SQL parser could not start. Create .venv and install services/sqlparse/requirements.txt.');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code ?? 1;});
// Stopping this wrapper stops the parser too; otherwise the Python process outlives it, keeps the port, and later
// tests silently talk to an old parser.
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>{child.kill(signal);child.once('exit',()=>process.exit());setTimeout(()=>process.exit(),3000).unref();});

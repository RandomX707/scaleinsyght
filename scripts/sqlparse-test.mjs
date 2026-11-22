import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.platform === 'win32' ? join(root,'.venv','Scripts','python.exe') : join(root,'.venv','bin','python');
const result = spawnSync(python,['-m','unittest','discover','-s','services/sqlparse','-p','test_*.py','-v'],{cwd:root,stdio:'inherit'});
if(result.error){console.error('SQL parser tests need .venv with services/sqlparse/requirements.txt installed.');process.exitCode=1;}
else process.exitCode=result.status ?? 1;

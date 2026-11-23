import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

config({path:resolve('.env')});
const rawUrl=process.env.DATABASE_URL_SAMPLE_SOURCE;
if(!rawUrl||rawUrl.includes('replace-me'))throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; run pnpm db:setup:sample first');
const url=new URL(rawUrl);
const projectDir=resolve('services/dbt/sample_project');
const profilesDir=resolve('.local/dbt/profiles');
const profilesPath=resolve(profilesDir,'profiles.yml');
mkdirSync(profilesDir,{recursive:true});
const profile=[
  'scaleinsyght_sample_hospital:',
  '  target: local',
  '  outputs:',
  '    local:',
  '      type: postgres',
  `      host: ${url.hostname}`,
  `      port: ${url.port||5432}`,
  `      user: ${decodeURIComponent(url.username)}`,
  `      password: '${decodeURIComponent(url.password).replaceAll("'","''")}'`,
  `      dbname: ${url.pathname.slice(1)}`,
  '      schema: public',
  '      threads: 1',
  '      connect_timeout: 10',
].join('\n')+'\n';
writeFileSync(profilesPath,profile,{mode:0o600});
const executable=resolve('.venv','bin','dbt');
execFileSync(executable,['compile','--project-dir',projectDir,'--profiles-dir',profilesDir,'--target','local'],{stdio:'inherit',env:{...process.env,DBT_TARGET_PATH:resolve('.local/dbt/target')}});
const manifest=resolve('.local/dbt/target/manifest.json');
process.stdout.write(`Generated local dbt manifest: ${manifest}\n`);

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { config } from 'dotenv';

config({path:resolve(process.cwd(),'.env'),override:false});

const execFile=promisify(execFileCallback);
const MAGIC=Buffer.from('SI-BACKUP-1\0');
export function encryptBackup(plain:Buffer,key:Buffer):Buffer{
  if(key.length!==32)throw new Error('backup_key_invalid');
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([MAGIC,iv,cipher.getAuthTag(),encrypted]);
}
export function decryptBackup(blob:Buffer,key:Buffer):Buffer{
  if(key.length!==32||blob.length<MAGIC.length+28||!blob.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('backup_authentication_failed');
  try{const iv=blob.subarray(MAGIC.length,MAGIC.length+12);const tag=blob.subarray(MAGIC.length+12,MAGIC.length+28);const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(blob.subarray(MAGIC.length+28)),decipher.final()]);}
  catch{throw new Error('backup_authentication_failed');}
}

function databaseUrl(url:string,database:string):string{const parsed=new URL(url);parsed.pathname=`/${database}`;return parsed.toString();}
function pgEnv(url:string):NodeJS.ProcessEnv{
  const parsed=new URL(url);return {...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port||'5432',PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password),PGDATABASE:parsed.pathname.slice(1)};
}
function identifier(value:string):string{return `"${value.replaceAll('"','""')}"`;}
function backupKey(encoded:string|undefined):Buffer{
  if(!encoded)throw new Error('BACKUP_ENCRYPTION_KEY is required');const key=Buffer.from(encoded,'base64');if(key.length!==32)throw new Error('BACKUP_ENCRYPTION_KEY must be base64 for exactly 32 bytes');return key;
}

export async function runBackupDrill(options:{encryptionKey?:string;volumePath?:string;adminUrl?:string;migrateUrl?:string}={}):Promise<{rpoSeconds:number;rtoSeconds:number;rows:number;backupPath:string}>{
  const started=Date.now();const adminUrl=options.adminUrl??process.env.DATABASE_URL_ADMIN;
  const migrateUrl=options.migrateUrl??process.env.DATABASE_URL_MIGRATE;if(!migrateUrl)throw new Error('DATABASE_URL_MIGRATE is required for the isolated backup drill');
  const key=backupKey(options.encryptionKey??process.env.BACKUP_ENCRYPTION_KEY);const id=randomBytes(8).toString('hex');const sourceName=`si_bkp_${id}`;const restoreName=`si_rst_${id}`;
  const volume=resolve(options.volumePath??process.env.BACKUP_VOLUME_PATH??'.local/backups');await mkdir(volume,{recursive:true});
  const temp=await mkdtemp(join(tmpdir(),'si-backup-drill-'));const plainPath=join(temp,'synthetic.dump');const restorePath=join(temp,'restore.dump');const backupPath=join(volume,`${new Date().toISOString().replaceAll(':','-')}-${id}.sibak`);
  const admin=new Client(adminUrl?{connectionString:adminUrl}:{host:process.env.PGHOST||'/tmp',port:Number(process.env.PGPORT||5432),user:process.env.USER||process.env.LOGNAME,database:'postgres'});let adminConnected=false;
  try{
    await admin.connect();adminConnected=true;
    await admin.query(`CREATE DATABASE ${identifier(sourceName)} OWNER si_migrate`);
    await admin.query(`CREATE DATABASE ${identifier(restoreName)} OWNER si_migrate`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(sourceName)} FROM PUBLIC`);await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(restoreName)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(sourceName)},${identifier(restoreName)} TO si_migrate`);
    const source=new Client({connectionString:databaseUrl(migrateUrl,sourceName)});await source.connect();
    const sampledAt=new Date();
    try{await source.query('CREATE TABLE public.drill_synthetic_sample(sampled_at timestamptz PRIMARY KEY,synthetic_count integer NOT NULL)');await source.query('INSERT INTO public.drill_synthetic_sample VALUES($1,12000),($2,11),($3,36)',[sampledAt,new Date(sampledAt.getTime()+1),new Date(sampledAt.getTime()+2)]);}finally{await source.end();}
    const dumpVersion=await execFile('pg_dump',['--version']);if(!dumpVersion.stdout.includes('16.'))throw new Error('postgres_client_16_required');
    await execFile('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',plainPath],{env:pgEnv(databaseUrl(migrateUrl,sourceName)),maxBuffer:1024*1024});
    const encrypted=encryptBackup(await readFile(plainPath),key);await writeFile(backupPath,encrypted,{mode:0o600,flag:'wx'});await rm(plainPath,{force:true});
    const decrypted=decryptBackup(await readFile(backupPath),key);await writeFile(restorePath,decrypted,{mode:0o600,flag:'wx'});
    await execFile('pg_restore',['--exit-on-error','--no-owner','--no-privileges','--dbname',restoreName,restorePath],{env:pgEnv(databaseUrl(migrateUrl,restoreName)),maxBuffer:1024*1024});
    const restored=new Client({connectionString:databaseUrl(migrateUrl,restoreName)});await restored.connect();let rows=0;let latest:Date|undefined;
    try{const check=await restored.query<{count:string;latest:Date}>('SELECT count(*)::text AS count,max(sampled_at) AS latest FROM public.drill_synthetic_sample');rows=Number(check.rows[0]!.count);latest=check.rows[0]!.latest;}finally{await restored.end();}
    if(rows!==3||!latest||latest.getTime()<sampledAt.getTime())throw new Error('backup_restore_content_mismatch');
    const rpoSeconds=(Date.now()-latest.getTime())/1000;const rtoSeconds=(Date.now()-started)/1000;
    if(rpoSeconds>900)throw new Error('backup_rpo_target_missed');if(rtoSeconds>=14_400)throw new Error('backup_rto_target_missed');
    return {rpoSeconds,rtoSeconds,rows,backupPath};
  }finally{
    if(adminConnected){for(const name of [restoreName,sourceName]){try{await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`,[name]);await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);}catch{/* cleanup may run after a partial setup */}}await admin.end();}
    await rm(temp,{recursive:true,force:true});
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runBackupDrill().then((result)=>{process.stdout.write(`Backup restore drill passed: rows=${result.rows}, RPO=${result.rpoSeconds.toFixed(3)}s, RTO=${result.rtoSeconds.toFixed(3)}s, encrypted artifact=${result.backupPath}\n`);}).catch((error:unknown)=>{const code=error instanceof Error?error.message:'backup_restore_failed';process.stderr.write(`Backup restore drill failed: ${code}\n`);process.exitCode=1;});
}

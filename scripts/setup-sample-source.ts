import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: resolve('.env') });
const database = 'si_sample_source';
const role = 'si_source_ro';
function quoteLiteral(value:string):string{return `'${value.replaceAll("'","''")}'`;}
function quoteIdentifier(value:string):string{return `"${value.replaceAll('"','""')}"`;}

function saveEnvValue(key: string, value: string): void {
  const path = resolve('.env');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const match = lines.findIndex((line) => line.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (match >= 0) lines[match] = line;
  else lines.push(line);
  writeFileSync(path, `${lines.filter((entry, index) => entry || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

const admin = new Client(process.env.DATABASE_URL_ADMIN
  ? { connectionString: process.env.DATABASE_URL_ADMIN }
  : { host: process.env.PGHOST || '/tmp', port: Number(process.env.PGPORT || 5432), user: process.env.USER || process.env.LOGNAME, database: 'postgres' });
await admin.connect();
const rolePassword = process.env.SAMPLE_SOURCE_PASSWORD && process.env.SAMPLE_SOURCE_PASSWORD!=='replace-me'
  ? process.env.SAMPLE_SOURCE_PASSWORD : randomBytes(32).toString('base64url');
const envUrl = new URL(`postgresql://${role}@127.0.0.1:${process.env.PGPORT || 5432}/${database}`);
envUrl.password = rolePassword;
try {
  const identity = await admin.query<{ rolsuper: boolean; current_user:string }>('SELECT r.rolsuper,current_user FROM pg_roles r WHERE r.rolname=current_user');
  if (!identity.rows[0]?.rolsuper) throw new Error('Sample source setup requires the local PostgreSQL superuser.');
  const existingRole = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  if (existingRole.rowCount) await admin.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(rolePassword)}`);
  else await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(rolePassword)}`);
  const existingDb = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
  const owner=quoteIdentifier(identity.rows[0]!.current_user);
  if (!existingDb.rowCount) await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  else await admin.query(`ALTER DATABASE ${database} OWNER TO ${owner}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
} finally {
  await admin.end();
}

const sourceAdminUrl=process.env.DATABASE_URL_ADMIN?new URL(process.env.DATABASE_URL_ADMIN):null;
if(sourceAdminUrl)sourceAdminUrl.pathname=`/${database}`;
const source = new Client(sourceAdminUrl?{connectionString:sourceAdminUrl.toString()}:{host:process.env.PGHOST||'/tmp',port:Number(process.env.PGPORT||5432),user:process.env.USER||process.env.LOGNAME,database});
await source.connect();
try {
  await source.query('BEGIN');
  await source.query(`CREATE TABLE IF NOT EXISTS departments(department_id integer PRIMARY KEY, department_code text NOT NULL UNIQUE, department_name text NOT NULL);
    CREATE TABLE IF NOT EXISTS providers(provider_id integer PRIMARY KEY, department_id integer NOT NULL REFERENCES departments, provider_name text NOT NULL, specialty text NOT NULL);
    CREATE TABLE IF NOT EXISTS patients(patient_id integer PRIMARY KEY, patient_code text NOT NULL UNIQUE, patient_name text NOT NULL, birth_date date NOT NULL, synthetic_sex text NOT NULL);
    CREATE TABLE IF NOT EXISTS encounters(encounter_id integer PRIMARY KEY, patient_id integer NOT NULL REFERENCES patients, department_id integer NOT NULL REFERENCES departments, provider_id integer NOT NULL REFERENCES providers, admitted_at timestamptz NOT NULL, discharged_at timestamptz);
    CREATE TABLE IF NOT EXISTS orders(order_id integer PRIMARY KEY, encounter_id integer NOT NULL REFERENCES encounters, ordering_provider_id integer NOT NULL REFERENCES providers, order_type text NOT NULL, order_status text NOT NULL, ordered_at timestamptz NOT NULL);
    INSERT INTO departments VALUES
      (1,'D-001','Synthetic Cardiology'),(2,'D-002','Synthetic Neurology'),(3,'D-003','Synthetic Oncology'),(4,'D-004','Synthetic Emergency'),
      (5,'D-005','Synthetic Pediatrics'),(6,'D-006','Synthetic Imaging'),(7,'D-007','Synthetic Laboratory'),(8,'D-008','Synthetic Surgery'),
      (9,'D-009','Synthetic Pharmacy'),(10,'D-010','Synthetic Primary Care'),(11,'D-011','Synthetic Intensive Care'),(12,'D-012','Synthetic Rehabilitation')
      ON CONFLICT(department_id) DO NOTHING;
    INSERT INTO providers SELECT n,((n-1)%12)+1,'Synthetic Provider '||lpad(n::text,4,'0'),(ARRAY['General','Cardiology','Radiology','Pediatrics','Surgery'])[ ((n-1)%5)+1 ] FROM generate_series(1,120) n ON CONFLICT(provider_id) DO NOTHING;
    INSERT INTO patients SELECT n,'SYN-P-'||lpad(n::text,6,'0'),'Synthetic Patient '||lpad(n::text,6,'0'),date '1930-01-01'+((n*17)%30000),(ARRAY['F','M','X'])[ ((n-1)%3)+1 ] FROM generate_series(1,6000) n ON CONFLICT(patient_id) DO NOTHING;
    INSERT INTO encounters SELECT n,((n-1)%6000)+1,((n-1)%12)+1,((n-1)%120)+1,timestamptz '2020-01-01 00:00:00+00'+(n%2000)*interval '1 hour',CASE WHEN n%8=0 THEN NULL ELSE timestamptz '2020-01-01 00:00:00+00'+(n%2000)*interval '1 hour'+interval '1 day' END FROM generate_series(1,12000) n ON CONFLICT(encounter_id) DO NOTHING;
    INSERT INTO orders SELECT n,((n-1)%12000)+1,((n-1)%120)+1,(ARRAY['lab','medication','imaging','procedure'])[ ((n-1)%4)+1 ],(ARRAY['placed','completed','cancelled'])[ ((n-1)%3)+1 ],timestamptz '2020-01-01 00:00:00+00'+(n%2000)*interval '1 hour' FROM generate_series(1,24000) n ON CONFLICT(order_id) DO NOTHING;
    COMMENT ON COLUMN patients.patient_id IS 'sensitivity:identifier';
    COMMENT ON COLUMN encounters.patient_id IS 'sensitivity:identifier';
    COMMENT ON COLUMN orders.encounter_id IS 'sensitivity:identifier';
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON departments,providers,patients,encounters,orders TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role};`);
  const counts = await source.query<{ total: string }>('SELECT (SELECT count(*) FROM patients)+(SELECT count(*) FROM encounters)+(SELECT count(*) FROM orders)+(SELECT count(*) FROM providers)+(SELECT count(*) FROM departments) AS total');
  if (Number(counts.rows[0]!.total) < 10_000) throw new Error('Synthetic sample source must contain at least 10,000 rows.');
  await source.query('COMMIT');
} catch (error) {
  await source.query('ROLLBACK');
  throw error;
} finally {
  await source.end();
}

saveEnvValue('SAMPLE_SOURCE_PASSWORD', rolePassword);
saveEnvValue('DATABASE_URL_SAMPLE_SOURCE', envUrl.toString());
  process.stdout.write('Synthetic PostgreSQL source is ready (42,132 fake rows; read-only connector role).\n');

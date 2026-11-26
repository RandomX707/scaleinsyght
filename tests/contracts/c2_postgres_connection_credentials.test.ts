import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildTestServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { runQueuedDiscoveries } from '../support/discovery.js';

config({path:'.env'});
const testUrl=(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE')=>{const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL credential contracts are never skipped`);const url=new URL(value);url.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;return url.toString();};
const appPool=new Pool({connectionString:testUrl('DATABASE_URL')});const adminPool=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});
const tenantId=`postgres-ui-${randomUUID()}`;const email=`admin@${tenantId}.synthetic.invalid`;const pass='postgres-ui-test-password';
let server:Awaited<ReturnType<typeof buildTestServer>>;let cookie='';

describe('contract 2 PostgreSQL credentials through the connection API',()=>{
  beforeAll(async()=>{
    process.env.CONNECTION_SECRET_KEY=Buffer.alloc(32,31).toString('base64');
    await withTenant(adminPool,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[tenantId,email,hashPassword(pass),'Test User']);});
    server=await buildTestServer({pool:appPool,sessionSecret:'phase2-postgres-credential-contract-secret-012345',testAccounts:[{tenantId,email}]});
    const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email,password:pass}});cookie=String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async()=>{await server?.close();await appPool.end();await adminPool.end();delete process.env.CONNECTION_SECRET_KEY;});

  it('c2_real_postgres_credentials_are_encrypted_tested_read_only_and_profiled',async()=>{
    const sample=new URL(process.env.DATABASE_URL_SAMPLE_SOURCE??'');if(!sample.hostname)throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; PostgreSQL credential contracts are never skipped');
    const password=decodeURIComponent(sample.password);const input={connectorType:'postgres',displayName:'Hospital source',credential:{host:sample.hostname,port:Number(sample.port||5432),database:decodeURIComponent(sample.pathname.slice(1)),username:decodeURIComponent(sample.username),password,sslMode:'disable'}};
    const created=await server.inject({method:'POST',url:'/api/connections',headers:{cookie,'content-type':'application/json'},payload:input});expect(created.statusCode).toBe(201);expect(created.body).not.toContain(password);
    const connectionId=created.json<{connectionId:string}>().connectionId;
    const stored=await withTenant(adminPool,tenantId,db=>db.query<{ciphertext:Buffer;nonce:Buffer;auth_tag:Buffer;display_name:string}>('SELECT s.ciphertext,s.nonce,s.auth_tag,c.display_name FROM registry.connection_secrets s JOIN registry.connections c USING(tenant_id,connection_id) WHERE s.tenant_id=$1 AND s.connection_id=$2',[tenantId,connectionId]));
    expect(stored.rows).toHaveLength(1);expect(stored.rows[0]!.ciphertext.toString()).not.toContain(password);expect(stored.rows[0]!.display_name).toBe('Hospital source');
    const tested=await server.inject({method:'POST',url:`/api/connections/${connectionId}/test`,headers:{cookie}});expect(tested.statusCode).toBe(200);expect(tested.json()).toMatchObject({ok:true,readOnly:true});
    const activated=await server.inject({method:'POST',url:`/api/connections/${connectionId}/activate`,headers:{cookie},payload:{scope:[]}});expect(activated.statusCode).toBe(200);
    // Activation queues the profile (decision 57); run it as the worker would, then read the result.
    await runQueuedDiscoveries(tenantId);
    const profile=(await server.inject({method:'GET',url:`/api/connections/${connectionId}/profile`,headers:{cookie}})).json<{profile:{state:string;profiled_count:number}}>().profile;
    expect(profile.state).toBe('COMPLETED');expect(profile.profiled_count).toBeGreaterThan(0);
  });
});

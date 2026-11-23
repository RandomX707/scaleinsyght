import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; OIDC contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}

const tenantId = `phase6-oidc-${randomUUID()}`;
const issuer = 'https://issuer.synthetic.invalid/';
const issuerBase = 'https://issuer.synthetic.invalid';
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL'), max: 2 });
const migratePool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 1 });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = 'oidc-contract-key';
const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'RS256' };
let requestedNonce = '';
let requestedChallenge = '';
let idTokenAudience = 'scale-insyght-contract';
let idTokenIssuer = issuer;
let tokenExchangeCalls = 0;
let server: Awaited<ReturnType<typeof buildServer>>;

function tokenFor(nonce: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ iss: idTokenIssuer, aud: idTokenAudience, nonce, sub: 'synthetic-subject-1', email: 'analyst@synthetic.invalid', email_verified: true, iat: now, exp: now + 120 });
  const signed = `${header}.${payload}`;
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), pair.privateKey).toString('base64url')}`;
}

const oidcFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === `${issuerBase}/.well-known/openid-configuration`) {
    return new Response(JSON.stringify({ issuer, authorization_endpoint: `${issuerBase}/authorize`, token_endpoint: `${issuerBase}/token`, jwks_uri: `${issuerBase}/jwks` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === `${issuerBase}/token`) {
    tokenExchangeCalls += 1;
    const body = String(init?.body ?? '');
    const verifier = new URLSearchParams(body).get('code_verifier');
    if (!verifier || createHash('sha256').update(verifier).digest('base64url') !== requestedChallenge) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ id_token: tokenFor(requestedNonce) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === `${issuerBase}/jwks`) return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('unexpected_synthetic_oidc_url');
};

describe('contract 1 OIDC with PKCE', () => {
  let sessionCookie = '';
  beforeAll(async () => {
    process.env.OIDC_TEST_CLIENT_SECRET = 'synthetic-oidc-client-secret';
    process.env.OIDC_REDIRECT_URI = 'https://app.synthetic.invalid/api/auth/oidc/callback';
    await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, 'analyst@synthetic.invalid', hashPassword('synthetic-login-password')]);
      const user = await db.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]);
      await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.sso.configure',true)",[tenantId,user.rows[0]!.user_id]);
    });
    server = await buildServer({ pool: appPool, sessionSecret: 'phase6-oidc-contract-session-secret-0123456789', goldenAccounts: [{ tenantId, email: 'analyst@synthetic.invalid' }], oidcFetch });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'analyst@synthetic.invalid', password: 'synthetic-login-password' } });
    sessionCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => {
    await server.close(); await appPool.end(); await migratePool.end(); delete process.env.OIDC_TEST_CLIENT_SECRET; delete process.env.OIDC_REDIRECT_URI;
  });

  it('c1_oidc_pkce_state_nonce_audience_and_tenant_are_verified', async () => {
    const configured = await server.inject({
      method: 'POST', url: '/api/tenant/sso', headers: { cookie: sessionCookie },
      payload: { issuer, clientId: 'scale-insyght-contract', clientSecretRef: 'OIDC_TEST_CLIENT_SECRET', allowedEmailDomains: ['synthetic.invalid'] },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toEqual({ enabled: true, issuer, clientId: 'scale-insyght-contract', clientSecretRef: 'OIDC_TEST_CLIENT_SECRET', allowedEmailDomains: ['synthetic.invalid'] });
    expect(JSON.stringify(configured.json())).not.toContain('synthetic-oidc-client-secret');
    const settings = await server.inject({ method: 'GET', url: '/api/tenant/sso', headers: { cookie: sessionCookie } });
    expect(JSON.stringify(settings.json())).not.toContain('synthetic-oidc-client-secret');
    const stored = await withTenant(appPool, tenantId, (db) => db.query<{ client_secret_ref: string }>('SELECT client_secret_ref FROM core.oidc_providers WHERE tenant_id=$1', [tenantId]));
    expect(stored.rows[0]?.client_secret_ref).toBe('OIDC_TEST_CLIENT_SECRET');

    const start = await server.inject({ method: 'GET', url: `/api/auth/oidc/${tenantId}/start` });
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    requestedNonce = authorize.searchParams.get('nonce') ?? '';
    requestedChallenge = authorize.searchParams.get('code_challenge') ?? '';
    const oidcCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const callback = await server.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=synthetic-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`, headers: { cookie: oidcCookie } });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers['set-cookie'])).toContain('si_session=');
    const oidcSessionCookie = String(callback.headers['set-cookie']).split(';')[0]!;
    expect((await server.inject({ method: 'GET', url: '/api/usage', headers: { cookie: oidcSessionCookie } })).statusCode).toBe(200);
    const identity = await withTenant(appPool, tenantId, (db) => db.query<{subject_hash:Buffer}>('SELECT subject_hash FROM core.external_identities WHERE tenant_id=$1',[tenantId]));
    expect(identity.rows[0]?.subject_hash).toHaveLength(32);
    const event = await withTenant(appPool, tenantId, (db) => db.query<{event_type:string}>('SELECT event_type FROM core.activity_events WHERE tenant_id=$1 AND event_type=$2',[tenantId,'sso_login_succeeded']));
    expect(event.rows).toHaveLength(1);
    expect(tokenExchangeCalls).toBe(1);
    expect((await server.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=synthetic-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`, headers: { cookie: oidcCookie } })).statusCode).toBe(400);
  });

  it('rejects a forged state before contacting the provider', async () => {
    const start = await server.inject({ method: 'GET', url: `/api/auth/oidc/${tenantId}/start` });
    const oidcCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const before = tokenExchangeCalls;
    const callback = await server.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=synthetic-code&state=forged-state`, headers: { cookie: oidcCookie } });
    expect(callback.statusCode).toBe(400);
    expect(tokenExchangeCalls).toBe(before);
  });

  it('rejects an ID token with the wrong audience', async () => {
    idTokenAudience = 'wrong-audience';
    const start = await server.inject({ method: 'GET', url: `/api/auth/oidc/${tenantId}/start` });
    const authorize = new URL(String(start.headers.location));
    requestedNonce = authorize.searchParams.get('nonce') ?? '';
    requestedChallenge = authorize.searchParams.get('code_challenge') ?? '';
    const oidcCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const callback = await server.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=synthetic-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`, headers: { cookie: oidcCookie } });
    expect(callback.statusCode).toBe(401);
    const event = await withTenant(appPool, tenantId, (db) => db.query<{safe_error_code:string}>('SELECT safe_error_code FROM core.activity_events WHERE tenant_id=$1 AND event_type=$2 ORDER BY occurred_at DESC LIMIT 1',[tenantId,'sso_login_failed']));
    expect(event.rows[0]?.safe_error_code).toBe('oidc_token_invalid');
    idTokenAudience = 'scale-insyght-contract';
  });

  it('rejects an ID token signed for a different issuer', async () => {
    idTokenIssuer = 'https://untrusted.synthetic.invalid/';
    const start = await server.inject({ method: 'GET', url: `/api/auth/oidc/${tenantId}/start` });
    const authorize = new URL(String(start.headers.location));
    requestedNonce = authorize.searchParams.get('nonce') ?? '';
    requestedChallenge = authorize.searchParams.get('code_challenge') ?? '';
    const oidcCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const callback = await server.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=synthetic-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`, headers: { cookie: oidcCookie } });
    expect(callback.statusCode).toBe(401);
    idTokenIssuer = issuer;
  });

  it('does not find a provider through another tenant identifier', async () => {
    const response = await server.inject({ method: 'GET', url: `/api/auth/oidc/${tenantId}-other/start` });
    expect(response.statusCode).toBe(404);
  });

  it('requires the tenant SSO configuration entitlement and keeps audit events append only', async () => {
    await withTenant(migratePool, tenantId, async (db) => { await db.query("DELETE FROM core.entitlements WHERE tenant_id=$1 AND capability_id='tenant.sso.configure'", [tenantId]); });
    const denied = await server.inject({ method: 'POST', url: '/api/tenant/sso', headers: { cookie: sessionCookie }, payload: { issuer, clientId: 'forged', clientSecretRef: 'OIDC_TEST_CLIENT_SECRET', allowedEmailDomains: ['synthetic.invalid'] } });
    expect(denied.statusCode).toBe(403);
    await withTenant(migratePool, tenantId, async (db) => {
      const user = await db.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]);
      await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.sso.configure',true)",[tenantId,user.rows[0]!.user_id]);
    });
    await expect(withTenant(appPool, tenantId, (db) => db.query("UPDATE core.activity_events SET event_type='user_active' WHERE tenant_id=$1 AND event_type='sso_login_succeeded'", [tenantId]))).rejects.toThrow('append only');
  });
});

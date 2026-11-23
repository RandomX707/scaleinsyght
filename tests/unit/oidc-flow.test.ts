import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createOidcAuthorizationRequest, verifyOidcIdToken } from '@scaleinsyght/auth-oidc';

function syntheticIdToken(input: { issuer: string; audience: string | string[]; nonce: string; subject: string; authorizedParty?: string }, keyId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ iss: input.issuer, aud: input.audience, ...(input.authorizedParty ? { azp: input.authorizedParty } : {}), nonce: input.nonce, sub: input.subject, iat: now, exp: now + 120, email: 'person@synthetic.invalid', email_verified: true });
  const content = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
  return `${content}.${signature}`;
}

describe('OIDC authorization and token verification', () => {
  it('creates an authorization-code request with PKCE, state, nonce, and the openid scope', () => {
    const result = createOidcAuthorizationRequest({
      authorizationEndpoint: 'https://issuer.synthetic.invalid/authorize',
      clientId: 'scale-insyght-test-client',
      redirectUri: 'https://app.synthetic.invalid/api/auth/oidc/callback',
    });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('nonce')).toBe(result.nonce);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(result.codeVerifier).digest('base64url'));
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('verifies signature, issuer, audience, expiry, and nonce before returning claims', async () => {
    const issuer = 'https://issuer.synthetic.invalid';
    const nonce = 'synthetic-nonce-0123456789';
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key-1', alg: 'RS256' };
    const token = syntheticIdToken({ issuer, audience: 'scale-insyght-client', nonce, subject: 'synthetic-user-1' }, jwk.kid, privateKey);

    const claims = await verifyOidcIdToken(token, {
      issuer,
      audience: 'scale-insyght-client',
      nonce,
      jwks: { keys: [jwk] },
    });
    expect(claims.sub).toBe('synthetic-user-1');
    expect(claims.email_verified).toBe(true);
  });

  it('rejects an ID token with a different nonce', async () => {
    const issuer = 'https://issuer.synthetic.invalid';
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key-2', alg: 'RS256' };
    const token = syntheticIdToken({ issuer, audience: 'scale-insyght-client', nonce: 'another-nonce', subject: 'synthetic-user-2' }, jwk.kid, privateKey);
    await expect(verifyOidcIdToken(token, {
      issuer,
      audience: 'scale-insyght-client',
      nonce: 'expected-nonce',
      jwks: { keys: [jwk] },
    })).rejects.toThrow('oidc_token_invalid');
  });

  it('rejects a multi-audience ID token with the wrong authorized party', async () => {
    const issuer = 'https://issuer.synthetic.invalid';
    const nonce = 'multi-audience-nonce';
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key-3', alg: 'RS256' };
    const token = syntheticIdToken({ issuer, audience: ['scale-insyght-client', 'another-client'], authorizedParty: 'another-client', nonce, subject: 'synthetic-user-3' }, jwk.kid, privateKey);
    await expect(verifyOidcIdToken(token, { issuer, audience: 'scale-insyght-client', nonce, jwks: { keys: [jwk] } })).rejects.toThrow('oidc_token_invalid');
  });
});

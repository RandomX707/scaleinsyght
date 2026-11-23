import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

export type OidcAuthorizationRequestConfig = {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
};

export type OidcAuthorizationRequest = {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};

export type VerifyOidcIdTokenOptions = {
  issuer: string;
  audience: string;
  nonce: string;
  jwks: JSONWebKeySet;
};

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('oidc_https_required');
  return url;
}

export function createOidcAuthorizationRequest(config: OidcAuthorizationRequestConfig): OidcAuthorizationRequest {
  if (!config.clientId.trim()) throw new Error('oidc_client_id_required');
  const authorization = checkedUrl(config.authorizationEndpoint);
  const redirect = checkedUrl(config.redirectUri);
  const state = randomOpaqueValue();
  const nonce = randomOpaqueValue();
  const codeVerifier = randomOpaqueValue();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('client_id', config.clientId);
  authorization.searchParams.set('redirect_uri', redirect.toString());
  authorization.searchParams.set('scope', 'openid email profile');
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('nonce', nonce);
  authorization.searchParams.set('code_challenge', codeChallenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return { authorizationUrl: authorization.toString(), state, nonce, codeVerifier };
}

export async function verifyOidcIdToken(token: string, options: VerifyOidcIdTokenOptions): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(options.jwks), {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce'],
      maxTokenAge: '5m',
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.nonce !== options.nonce) throw new Error('invalid_subject_or_nonce');
    if ((payload.azp !== undefined && payload.azp !== options.audience) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.audience)) throw new Error('invalid_authorized_party');
    return payload;
  } catch {
    throw new Error('oidc_token_invalid');
  }
}

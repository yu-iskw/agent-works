export type GoogleClient = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch: typeof fetch;
};

type GoogleIdentity = {
  readonly sub: string;
  readonly email: string;
  readonly hostedDomain: string | undefined;
};

export type GoogleGrant = {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
  readonly scope: string;
  readonly identity: GoogleIdentity;
};

/** Carries only a fixed reason. Google's response body is never echoed, so tokens cannot reach logs. */
export class GoogleRejected extends Error {
  constructor(readonly reason: 'token_exchange' | 'revoke' | 'identity') {
    super(reason);
    this.name = 'GoogleRejected';
  }
}

const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revokeEndpoint = 'https://oauth2.googleapis.com/revoke';

export async function exchangeCode(
  client: GoogleClient,
  input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
): Promise<GoogleGrant> {
  const response = await client.fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  });
  if (!response.ok) throw new GoogleRejected('token_exchange');
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new GoogleRejected('token_exchange');
  const accessToken = stringField(body, 'access_token');
  const scope = stringField(body, 'scope');
  const idToken = stringField(body, 'id_token');
  const expiresInSeconds = Reflect.get(body, 'expires_in');
  if (
    accessToken === undefined ||
    scope === undefined ||
    idToken === undefined ||
    typeof expiresInSeconds !== 'number'
  ) {
    throw new GoogleRejected('token_exchange');
  }
  return {
    accessToken,
    refreshToken: stringField(body, 'refresh_token'),
    expiresInSeconds,
    scope,
    identity: readIdentity(idToken),
  };
}

export async function revokeGoogleToken(client: GoogleClient, token: string): Promise<void> {
  const response = await client.fetch(revokeEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok) throw new GoogleRejected('revoke');
}

/**
 * The ID token arrives straight from Google's token endpoint over TLS. OpenID Connect Core 3.1.3.7
 * allows TLS server validation in place of a signature check for that case, so only claims are read here.
 */
function readIdentity(idToken: string): GoogleIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleRejected('identity');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleRejected('identity');
  }
  if (!isRecord(claims)) throw new GoogleRejected('identity');
  const sub = stringField(claims, 'sub');
  const email = stringField(claims, 'email');
  if (sub === undefined || email === undefined || Reflect.get(claims, 'email_verified') !== true) {
    throw new GoogleRejected('identity');
  }
  return { sub, email, hostedDomain: stringField(claims, 'hd') };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

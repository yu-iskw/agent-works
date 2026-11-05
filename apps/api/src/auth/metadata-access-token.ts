import * as z from 'zod';

/** Cloud Run exposes the service account's access token on the metadata server. No key file is read. */
const metadataTokenUrl =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const refreshMarginMs = 60_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export type AccessTokenSource = () => Promise<string>;

export type MetadataTokenOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

export function createMetadataAccessToken(options: MetadataTokenOptions = {}): AccessTokenSource {
  const load = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;

  return async () => {
    if (cached !== undefined && cached.expiresAt - refreshMarginMs > now()) return cached.token;
    const response = await load(metadataTokenUrl, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!response.ok) throw new Error('metadata access token unavailable');
    const parsed = tokenSchema.safeParse((await response.json()) as unknown);
    if (!parsed.success) throw new Error('metadata access token malformed');
    cached = {
      token: parsed.data.access_token,
      expiresAt: now() + parsed.data.expires_in * 1000,
    };
    return cached.token;
  };
}

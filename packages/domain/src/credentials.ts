import * as z from 'zod';

const label = z.string().min(1);
const instant = z.iso.datetime();
const status = z.enum(['active', 'revoked', 'expired']);

const startFields = {
  provider: label,
  state: label,
  codeChallenge: label,
  codeChallengeMethod: z.literal('S256'),
  scope: label,
};

const callbackFields = {
  provider: label,
  state: label,
  code: label,
  codeVerifier: label,
};

const connectionFields = {
  provider: label,
  subject: label,
  scope: label,
  status,
  expiresAt: instant,
  tokenRef: label,
};

export const oauthStartSchema = z.strictObject(startFields);
export const oauthStartedSchema = z.strictObject({
  ...startFields,
  authorizationUrl: z.url(),
});
export const oauthCallbackSchema = z.strictObject(callbackFields);
export const oauthConnectionSchema = z.strictObject(connectionFields);

export const oauthApiSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), ...startFields }),
  oauthStartedSchema.extend({ kind: z.literal('started') }),
  z.strictObject({ kind: z.literal('callback'), ...callbackFields }),
  z.strictObject({ kind: z.literal('connection'), ...connectionFields }),
]);

export type OAuthStart = z.infer<typeof oauthStartSchema>;
export type OAuthCallback = z.infer<typeof oauthCallbackSchema>;
export type OAuthConnection = z.infer<typeof oauthConnectionSchema>;
export type OAuthApi = z.infer<typeof oauthApiSchema>;

export type OAuthStarted = z.infer<typeof oauthStartedSchema>;

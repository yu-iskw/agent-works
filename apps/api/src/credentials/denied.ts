const stateMismatch = 'state_mismatch';
const pkceMismatch = 'pkce_mismatch';
const rejected = 'rejected';
const missing = 'missing';

export const oauthFailure = {
  stateMismatch,
  pkceMismatch,
  rejected,
  missing,
} as const;

export type OAuthFailure = (typeof oauthFailure)[keyof typeof oauthFailure];

export class OAuthDenied extends Error {
  readonly code: OAuthFailure;

  constructor(code: OAuthFailure) {
    super(code);
    this.name = 'OAuthDenied';
    this.code = code;
  }
}

export type OAuthGrant = {
  readonly provider: string;
  readonly subject: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope: string;
};

export interface GrantStore {
  save(grant: OAuthGrant): Promise<void>;
  read(state: string): Promise<OAuthGrant | undefined>;
  consume(state: string): Promise<OAuthGrant | undefined>;
}

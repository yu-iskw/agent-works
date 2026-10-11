import type { OAuthConnection } from '@agent-works/domain';

export interface CredentialsPort {
  save(connection: OAuthConnection): Promise<OAuthConnection>;
  read(subject: string, provider: string): Promise<OAuthConnection | undefined>;
}

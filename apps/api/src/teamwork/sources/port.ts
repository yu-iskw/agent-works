import type { Calculation, MetricsScope, SourceKind } from '@agent-works/domain/teamwork';

export type SourceItem = {
  readonly sourceKind: SourceKind;
  readonly sourceId: string;
  readonly title: string;
  /** Passage, line range or query cell the excerpt comes from. */
  readonly location: string;
  readonly excerpt: string;
  readonly url: string | null;
  readonly sourceRevision: string | null;
  readonly modifiedAt: string | null;
  readonly provenance: string;
};

type MetricRows = {
  readonly calculations: readonly Omit<Calculation, 'id' | 'evidenceId'>[];
  readonly definitions: SourceItem;
  readonly observations: SourceItem;
  readonly freshness: string | null;
};

export type SourceErrorCode =
  | 'not_connected'
  | 'token_expired'
  | 'denied'
  | 'not_found'
  | 'policy_denied'
  | 'empty'
  | 'unavailable'
  | 'invalid_scope';

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    readonly detail = '',
  ) {
    super(code);
    this.name = 'SourceError';
  }
}

export const sourceRemediation: Record<SourceErrorCode, string> = {
  not_connected:
    'Connect the account for this source on the Connections page of this segment, then retry.',
  token_expired:
    'The connection expired or was revoked. Reconnect it on the Connections page, then retry.',
  denied:
    'The provider denied access with your account. Check that the resource is shared with you, then retry.',
  not_found: 'The configured resource was not found. Check the segment configuration.',
  policy_denied: 'This segment does not allow that resource. Choose an allowlisted one.',
  empty: 'The source returned no matching data. Narrow or change the scope, then retry.',
  unavailable: 'The provider did not respond. Retry shortly.',
  invalid_scope: 'The task scope is incomplete for this source. Supply the missing input.',
};

/** A member's access token for one provider in this segment, refreshed if needed. */
export type TokenSource = (provider: 'google' | 'github') => Promise<string>;

export type SourceRequest = {
  readonly kind: SourceKind;
  readonly token: TokenSource;
  readonly query: string;
  readonly metrics: MetricsScope | null;
  readonly repository: string | null;
  readonly issueNumber: number | null;
};

export type SourceResult = {
  readonly items: readonly SourceItem[];
  readonly metrics: MetricRows | null;
  /** Pinned revision for code sources; recorded on the revision. */
  readonly repositoryRevision: string | null;
};

export type PublishRequest = {
  readonly token: TokenSource;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly markdown: string;
};

export type Published = {
  readonly documentId: string;
  readonly url: string;
  readonly confirmedAt: string;
};

export interface SourcePort {
  readonly mode: 'live' | 'fixture';
  read(request: SourceRequest): Promise<SourceResult>;
  /** Provider-side lookup by the idempotency marker; undefined when no such document exists. */
  findPublished(token: TokenSource, idempotencyKey: string): Promise<Published | undefined>;
  publish(request: PublishRequest): Promise<Published>;
}

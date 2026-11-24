import type { Caller } from '../../auth/iap.js';
import type { LedgerPort } from '../../ports/ledger-port.js';
import type { SearchPort } from '../../ports/search-port.js';
import type { Drive } from '../../retrieval/drive-port.js';
import type { GroupSnapshot } from '../../retrieval/search.js';
import type { AgentRunner } from '@agent-works/agent-runtime/port';
import type {
  AuditEvent,
  PolicyDecision,
  SearchContext,
  SkillManifest,
  TaskSubmit,
} from '@agent-works/domain';
import type { PolicyInput } from '@agent-works/policy';

export type Audited<Reply> = { readonly event: AuditEvent; readonly reply: Reply };

export type AuditRun<Reply> =
  { readonly kind: 'done'; readonly reply: Reply } | { readonly kind: 'conflict' };

/** Runs `execute` at most once per request id and records the event it produces. */
export interface AskAudit {
  run<Reply>(requestId: string, execute: () => Promise<Audited<Reply>>): Promise<AuditRun<Reply>>;
}

export type AskRunner = {
  readonly runner: AgentRunner;
  /** Audited identity of the runner that answers. */
  readonly agentPrincipal: string;
};

export type AskRetrieval = Pick<Drive, 'retrieve'>;

export type AskPolicy = (input: PolicyInput) => PolicyDecision;

export type AskClock = () => Date;

/** Ports of the authorized path: directory groups, policy facts, scoped search and the ledger. */
export type AskWire = {
  readonly search: SearchPort;
  readonly ledger: LedgerPort;
  readonly groups: (caller: Caller) => Promise<GroupSnapshot>;
  readonly policyInput?: (
    caller: Caller,
    context: SearchContext,
    resource?: { readonly request: TaskSubmit; readonly manifest: SkillManifest },
  ) => Promise<PolicyInput>;
};

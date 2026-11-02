import { defineRegistry } from '@agent-works/domain/connector-cdk';
import { workspaceManifests } from '@agent-works/domain/workspace-tools';

import { ConnectorError } from './errors.js';

import type { CallerCredential } from './google-http.js';
import type { ConnectorRegistry } from '@agent-works/domain/connector-cdk';
import type { WorkspaceReceipt, WorkspaceSource } from '@agent-works/domain/workspace-tools';
export type WorkspaceAdapters = {
  docs: {
    createDraft(
      credential: CallerCredential,
      payload: unknown,
      key: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceReceipt>;
  };
  calendar: {
    listEvents(
      credential: CallerCredential,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<readonly WorkspaceSource[]>;
    createEvent(
      credential: CallerCredential,
      payload: unknown,
      key: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceReceipt>;
  };
  gmail: {
    searchThreads(
      credential: CallerCredential,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<readonly WorkspaceSource[]>;
    createDraft(
      credential: CallerCredential,
      payload: unknown,
      key: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceReceipt>;
  };
};
export type WorkspaceInvocation = {
  readonly credential: CallerCredential;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
};
/** The kind must agree with the manifest side effect; the broker rejects a mismatch. */
export type WorkspaceHandler =
  | {
      readonly kind: 'read';
      run(call: WorkspaceInvocation): Promise<readonly WorkspaceSource[]>;
    }
  | { readonly kind: 'write'; run(call: WorkspaceInvocation): Promise<WorkspaceReceipt> };
export type WorkspaceRegistry = ConnectorRegistry<WorkspaceHandler>;
const denied: WorkspaceHandler = {
  kind: 'write',
  run: () => Promise.reject(new ConnectorError('POLICY_DENIED', 403)),
};
/** Adding a tool means one manifest and one entry here; the broker has no per-tool branch. */
export function createWorkspaceRegistry(adapters: WorkspaceAdapters): WorkspaceRegistry {
  return defineRegistry<WorkspaceHandler>(workspaceManifests, {
    'docs.createDraft': {
      kind: 'write',
      run: (c) => adapters.docs.createDraft(c.credential, c.payload, c.idempotencyKey, c.signal),
    },
    'calendar.listEvents': {
      kind: 'read',
      run: (c) => adapters.calendar.listEvents(c.credential, c.payload, c.signal),
    },
    'calendar.createEvent': {
      kind: 'write',
      run: (c) =>
        adapters.calendar.createEvent(c.credential, c.payload, c.idempotencyKey, c.signal),
    },
    'gmail.searchThreads': {
      kind: 'read',
      run: (c) => adapters.gmail.searchThreads(c.credential, c.payload, c.signal),
    },
    'gmail.createDraft': {
      kind: 'write',
      run: (c) => adapters.gmail.createDraft(c.credential, c.payload, c.idempotencyKey, c.signal),
    },
    'gmail.send': denied,
  });
}

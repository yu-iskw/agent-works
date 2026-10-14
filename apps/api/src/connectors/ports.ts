import type { CallerCredential } from './google-http.js';
import type {
  WorkspaceReceipt,
  WorkspaceSource,
} from '../../../../packages/domain/dist/workspace-tools.js';
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

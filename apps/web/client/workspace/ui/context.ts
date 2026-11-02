import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

import type { Effects } from '../store/effects.js';
import type { Store } from '../store/store.js';

export type Workspace = { readonly store: Store; readonly effects: Effects };

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === null) throw new Error('WorkspaceContext is not provided');
  return workspace;
}

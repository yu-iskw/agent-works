// Which panel an inbox item or result opens. The item's `ref` encodes what resolves it
// (`plan:<v>`, `approval:<id>`, `revision:<n>`, ...), so the panel is read from the ref and the
// task panel is the fallback for refs without a dedicated view.

import type { InboxRow } from '../../../shared/contract.js';
import type { PanelRoute } from '../../../shared/route.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Ref = { readonly head: string; readonly value: string };

const positive = (value: string): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Per kind: the panel its ref names, or undefined when the ref does not fit, then the task panel. */
const TARGETS: Partial<
  Readonly<Record<InboxRow['kind'], (taskId: string, ref: Ref) => PanelRoute | undefined>>
> = {
  plan_review: (taskId, ref) => {
    const version = positive(ref.value);
    return ref.head === 'plan' && version !== undefined
      ? { kind: 'plan', taskId, version }
      : undefined;
  },
  approval: (taskId, ref) =>
    ref.head === 'approval' && UUID.test(ref.value)
      ? { kind: 'approval', taskId, approvalId: ref.value }
      : undefined,
  completed: (taskId, ref) => {
    const revision = positive(ref.value);
    return ref.head === 'revision' && revision !== undefined
      ? { kind: 'result', taskId, revision, view: 'result', citation: null, compareTo: null }
      : undefined;
  },
};

export function inboxPanel(item: Pick<InboxRow, 'kind' | 'taskId' | 'ref'>): PanelRoute {
  const [head = '', value = ''] = item.ref.split(':');
  // `kind` is the closed InboxKind enum.

  const target = TARGETS[item.kind]?.(item.taskId, { head, value });
  return target ?? { kind: 'task', taskId: item.taskId };
}

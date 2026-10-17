import { IconPlus } from '@tabler/icons-react';

import { threadPreview, threadTitle } from '../lib/threads/state';

import { Button } from './ui/button';

import type { Thread } from '../lib/threads/state';

const sidebarClass =
  'flex h-full w-[17rem] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground';
const dockedClass = `${sidebarClass} shrink-0`;
const overlayClass = `${sidebarClass} fixed inset-y-0 left-0 z-30 shadow-xl`;

export function Sidebar({
  threads,
  activeThreadId,
  overlay,
  onNewQuestion,
  onSelect,
}: {
  readonly threads: readonly Thread[];
  readonly activeThreadId: string | null;
  readonly overlay: boolean;
  readonly onNewQuestion: () => void;
  readonly onSelect: (threadId: string) => void;
}) {
  return (
    <aside className={overlay ? overlayClass : dockedClass}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-2">
        <p className="truncate text-sm font-medium">agent-works</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="New question"
          onClick={onNewQuestion}
        >
          <IconPlus className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <nav aria-label="Questions" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 ? (
          <p className="px-3 py-2 text-sm text-balance text-muted-foreground">
            Questions appear here until you reload.
          </p>
        ) : (
          <ul className="flex flex-col">
            {threads.map((thread) => (
              <li key={thread.id}>
                <ThreadRow
                  thread={thread}
                  active={thread.id === activeThreadId}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function ThreadRow({
  thread,
  active,
  onSelect,
}: {
  readonly thread: Thread;
  readonly active: boolean;
  readonly onSelect: (threadId: string) => void;
}) {
  const preview = threadPreview(thread);
  const title = threadTitle(thread);
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(thread.id)}
      className={`flex w-full min-w-0 flex-col gap-0 rounded-lg px-2 py-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 ${active ? 'bg-sidebar-accent' : ''}`}
    >
      <span className="truncate text-[0.9rem] leading-5 font-medium tracking-[-0.01em]">
        {title}
      </span>
      {preview === '' ? null : (
        <span className="mt-px truncate text-xs leading-4 text-muted-foreground">{preview}</span>
      )}
    </button>
  );
}

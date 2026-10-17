import { IconLayoutSidebar } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';

import { Composer } from './components/composer';
import { Sidebar } from './components/sidebar';
import { ThemeToggle } from './components/theme-toggle';
import { Conversation } from './components/thread';
import { Button } from './components/ui/button';
import { askMutationOptions } from './lib/ask/mutations';
import { findThread, initialThreadsState, threadTitle, threadsReducer } from './lib/threads/state';

const desktopQuery = '(min-width: 768px)';
const askTitle = 'Ask';

type SidebarMode = 'docked' | 'overlay' | 'hidden';

export function App() {
  const [threads, dispatch] = useReducer(threadsReducer, initialThreadsState);
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktop = useDesktop();
  const mode = sidebarMode(desktop, desktopOpen, mobileOpen);
  const sidebarOpen = mode !== 'hidden';
  const active =
    threads.activeThreadId === null ? null : (findThread(threads, threads.activeThreadId) ?? null);

  const ask = useMutation({
    ...askMutationOptions(),
    onSuccess: (response, variables) => {
      dispatch({ type: 'turn/answered', requestId: variables.requestId, response });
    },
    onError: (error, variables) => {
      dispatch({ type: 'turn/failed', requestId: variables.requestId, message: error.message });
    },
  });

  useEffect(() => {
    if (mode !== 'overlay') {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') {
        return;
      }
      setMobileOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mode]);

  function toggleSidebar(): void {
    if (desktop) {
      setDesktopOpen((open) => !open);
      return;
    }
    setMobileOpen((open) => !open);
  }

  function openQuestion(): void {
    dispatch({ type: 'thread/opened', threadId: crypto.randomUUID() });
    setMobileOpen(false);
  }

  function selectThread(threadId: string): void {
    dispatch({ type: 'thread/selected', threadId });
    setMobileOpen(false);
  }

  function send(question: string): void {
    const threadId = threads.activeThreadId ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    dispatch({ type: 'turn/asked', threadId, requestId, question });
    ask.mutate({ requestId, question });
  }

  function retry(requestId: string, question: string): void {
    const nextRequestId = crypto.randomUUID();
    dispatch({ type: 'turn/retried', requestId, nextRequestId });
    ask.mutate({ requestId: nextRequestId, question });
  }

  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      {mode === 'overlay' ? (
        <div
          className="fixed inset-0 z-20 bg-black/10 backdrop-blur-xs"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      {mode === 'hidden' ? null : (
        <Sidebar
          threads={threads.threads}
          activeThreadId={threads.activeThreadId}
          overlay={mode === 'overlay'}
          onNewQuestion={openQuestion}
          onSelect={selectThread}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <IconLayoutSidebar className="size-4.5" aria-hidden="true" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {active === null ? askTitle : threadTitle(active)}
          </h1>
          <ThemeToggle />
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-4">
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
            <Conversation thread={active} onRetry={retry} />
            <div className="shrink-0 pt-2 pb-4">
              <Composer onAsk={send} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function sidebarMode(desktop: boolean, desktopOpen: boolean, mobileOpen: boolean): SidebarMode {
  if (desktop) {
    return desktopOpen ? 'docked' : 'hidden';
  }
  return mobileOpen ? 'overlay' : 'hidden';
}

function subscribeDesktop(onStoreChange: () => void): () => void {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener('change', onStoreChange);
  return () => {
    media.removeEventListener('change', onStoreChange);
  };
}

function desktopSnapshot(): boolean {
  return window.matchMedia(desktopQuery).matches;
}

function desktopServerSnapshot(): boolean {
  return true;
}

function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot);
}

import { IconArrowDown } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { TurnView } from './turn';
import { Button } from './ui/button';

import type { Thread, Turn } from '../lib/threads/state';

const awayFromEndPx = 120;
const emptyTurns: readonly Turn[] = [];

export function Conversation({
  thread,
  onRetry,
}: {
  readonly thread: Thread | null;
  readonly onRetry: (requestId: string, question: string) => void;
}) {
  const scrollerRef = useRef<HTMLElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const turns = thread?.turns ?? emptyTurns;
  const activeThreadId = thread?.id ?? null;
  const threadIdRef = useRef(activeThreadId);
  const previousTurns = useRef(turns);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const threadChanged = threadIdRef.current !== activeThreadId;
    const previous = previousTurns.current;
    threadIdRef.current = activeThreadId;
    previousTurns.current = turns;
    if (scroller === null) {
      return;
    }
    if (threadChanged) {
      pinToEnd(scroller);
      setShowScrollButton(false);
      return;
    }
    if (shouldFollow(previous, turns)) {
      pinToEnd(scroller);
      setShowScrollButton(false);
      return;
    }
    const away = distanceToEnd(scroller) > awayFromEndPx;
    setShowScrollButton((current) => (current === away ? current : away));
  }, [activeThreadId, turns]);

  function onScroll(): void {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const away = distanceToEnd(scroller) > awayFromEndPx;
    setShowScrollButton((current) => (current === away ? current : away));
  }

  function scrollToEnd(): void {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    pinToEnd(scroller);
    setShowScrollButton(false);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <section
        ref={scrollerRef}
        aria-label="Conversation"
        tabIndex={turns.length === 0 ? -1 : 0}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto overscroll-contain"
      >
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <h2 className="text-sm font-medium tracking-tight">Ask about your documents</h2>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-balance text-muted-foreground">
              Answers cite the documents they came from. Every question is recorded in the audit
              log.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 py-6">
            {turns.map((turn) => (
              <TurnView key={turn.requestId} turn={turn} onRetry={onRetry} />
            ))}
          </div>
        )}
      </section>
      {showScrollButton ? (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="Scroll to end"
            onClick={scrollToEnd}
          >
            <IconArrowDown className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function pinToEnd(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

function shouldFollow(previous: readonly Turn[], next: readonly Turn[]): boolean {
  if (next.length > previous.length) {
    return true;
  }
  return next.some((turn) => {
    if (turn.state.status !== 'answered') {
      return false;
    }
    const prior = previous.find((item) => item.requestId === turn.requestId);
    return prior === undefined || prior.state.status !== 'answered';
  });
}

function distanceToEnd(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

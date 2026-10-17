import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { pendingCopy } from '../lib/threads/state';

import { SourceList } from './source-list';
import { Button } from './ui/button';

import type { Turn } from '../lib/threads/state';

const copiedResetMs = 2000;
const wrappedCopy = 'break-words whitespace-pre-wrap';

export function TurnView({
  turn,
  onRetry,
}: {
  readonly turn: Turn;
  readonly onRetry: (requestId: string, question: string) => void;
}) {
  return (
    <article className="flex flex-col gap-3">
      <div className="flex justify-end">
        <p className={`max-w-[80%] rounded-xl bg-muted px-3 py-2 text-sm ${wrappedCopy}`}>
          {turn.question}
        </p>
      </div>
      <Assistant turn={turn} onRetry={onRetry} />
    </article>
  );
}

function Assistant({
  turn,
  onRetry,
}: {
  readonly turn: Turn;
  readonly onRetry: (requestId: string, question: string) => void;
}) {
  switch (turn.state.status) {
    case 'pending':
      return (
        <p
          role="status"
          className="animate-pulse text-sm text-muted-foreground motion-reduce:animate-none"
        >
          {pendingCopy}
        </p>
      );
    case 'answered':
      return (
        <div className="answer-in">
          <p className={`text-sm leading-relaxed ${wrappedCopy}`}>{turn.state.response.answer}</p>
          {turn.state.response.citations.length > 0 ? (
            <SourceList citations={turn.state.response.citations} />
          ) : null}
          <div className="mt-2 flex justify-start">
            <CopyAnswerButton answer={turn.state.response.answer} />
          </div>
        </div>
      );
    case 'failed':
      return (
        <div>
          <p
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
          >
            {turn.state.message}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => onRetry(turn.requestId, turn.question)}
          >
            Try again
          </Button>
        </div>
      );
    default: {
      const unreachable: never = turn.state;
      return unreachable;
    }
  }
}

function CopyAnswerButton({ answer }: { readonly answer: string }) {
  const [copyGeneration, setCopyGeneration] = useState(0);
  const copied = copyGeneration > 0;

  useEffect(() => {
    if (copyGeneration === 0) {
      return;
    }
    const timer = window.setTimeout(() => setCopyGeneration(0), copiedResetMs);
    return () => window.clearTimeout(timer);
  }, [copyGeneration]);

  function onCopy(): void {
    void navigator.clipboard.writeText(answer).then(
      () => setCopyGeneration((value) => value + 1),
      () => undefined,
    );
  }

  const Icon = copied ? IconCheck : IconCopy;

  return (
    <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
      <Icon className="size-4" aria-hidden="true" />
      {copied ? 'Copied' : 'Copy answer'}
    </Button>
  );
}

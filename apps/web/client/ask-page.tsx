import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { CitationList } from './components/citation-list';
import { askMutationOptions } from './lib/ask/mutations';

import type { AskResponse } from '@agent-works/domain';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FormEvent, KeyboardEvent } from 'react';

export function AskPage() {
  const [question, setQuestion] = useState('');
  const mutation = useMutation(askMutationOptions());
  const trimmed = question.trim();
  const pending = mutation.isPending;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed === '' || pending) {
      return;
    }
    mutation.mutate({ question: trimmed }, { onSuccess: () => setQuestion('') });
  }

  function onQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (trimmed === '' || pending) {
      return;
    }
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="mt-8 grid gap-3" onSubmit={onSubmit}>
      <label htmlFor="question" className="text-sm">
        Question
      </label>
      <textarea
        id="question"
        name="question"
        maxLength={1000}
        rows={3}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={onQuestionKeyDown}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div>
        <button
          type="submit"
          disabled={pending || trimmed === ''}
          className="rounded-lg bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
        >
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </div>
      <AskOutcome mutation={mutation} />
    </form>
  );
}

type AskMutation = UseMutationResult<AskResponse, Error, { readonly question: string }>;

function AskOutcome({ mutation }: { readonly mutation: AskMutation }) {
  switch (mutation.status) {
    case 'idle':
    case 'pending':
      return null;
    case 'error':
      return (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error.message}
        </p>
      );
    case 'success':
      return (
        <>
          <p className="answer-in whitespace-pre-wrap">{mutation.data.answer}</p>
          {mutation.data.citations.length > 0 ? (
            <>
              <h2 className="mt-6 text-sm font-medium">Sources</h2>
              <CitationList citations={mutation.data.citations} />
            </>
          ) : null}
        </>
      );
    default: {
      const unreachable: never = mutation;
      return unreachable;
    }
  }
}

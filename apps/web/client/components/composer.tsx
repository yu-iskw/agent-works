import { IconArrowUp } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { Button } from './ui/button';

import type { FormEvent, KeyboardEvent } from 'react';

const questionLimit = 1000;
const counterFrom = 800;
const questionHintId = 'question-hint';

export function Composer({ onAsk }: { readonly onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = question.trim();

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }

    resizeField(textarea);
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      if (nextWidth === width) {
        return;
      }
      width = nextWidth;
      resizeField(textarea);
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
    };
  }, [question]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed === '') {
      return;
    }
    onAsk(trimmed);
    setQuestion('');
  }

  function onQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (trimmed === '') {
      return;
    }
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="flex min-h-14 items-center gap-2 rounded-2xl border border-input bg-card px-3 py-3 focus-within:ring-3 focus-within:ring-ring/50">
        <label htmlFor="question" className="sr-only">
          Question
        </label>
        <p id={questionHintId} className="sr-only">
          Enter sends. Shift+Enter adds a line.
        </p>
        <textarea
          ref={textareaRef}
          id="question"
          name="question"
          rows={1}
          maxLength={questionLimit}
          value={question}
          placeholder="Ask a question about your documents"
          aria-describedby={questionHintId}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onQuestionKeyDown}
          className="max-h-[8lh] w-full flex-1 resize-none overflow-y-auto bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {question.length >= counterFrom ? (
          <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {question.length}/{questionLimit}
          </p>
        ) : null}
        <Button type="submit" size="icon" round aria-label="Ask" disabled={trimmed === ''}>
          <IconArrowUp className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

function resizeField(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

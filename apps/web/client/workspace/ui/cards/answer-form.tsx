// The one control that answers a specialist's question, shared by the question card and the task
// panel so an answer from the inbox resolves the same assignment the card would.

import { useState } from 'preact/hooks';

import { requestId } from '../../../../shared/request-id.js';

import { ErrorLine, useCommand } from './bits.jsx';

import type { JSX } from 'preact';

export function AnswerForm(props: {
  readonly id: string;
  readonly taskId: string;
  readonly assignmentId: string;
}): JSX.Element {
  const command = useCommand(props.taskId);
  const [text, setText] = useState('');
  // Not crypto.randomUUID: the local stack is plain http, where that API does not exist.
  const [clientRequestId] = useState(() => requestId((bytes) => crypto.getRandomValues(bytes)));
  const answer = async () => {
    if (text.trim() === '') return;
    const outcome = await command.run('follow-up', {
      clientRequestId,
      kind: 'answer',
      text: text.trim(),
      assignmentId: props.assignmentId,
      metrics: null,
    });
    if (outcome.ok) setText('');
  };
  return (
    <form
      class="answer"
      onSubmit={(event) => {
        event.preventDefault();
        void answer();
      }}
    >
      <label class="visually-hidden" for={`${props.id}-answer`}>
        Your answer
      </label>
      <textarea
        id={`${props.id}-answer`}
        rows={2}
        value={text}
        placeholder="Answer so the specialist can continue"
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <button type="submit" class="btn btn-primary btn-sm" disabled={command.busy}>
        Send answer
      </button>
      <ErrorLine text={command.error} />
    </form>
  );
}

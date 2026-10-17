import { describe, expect, it } from 'vitest';

import { initialThreadsState, threadPreview, threadTitle, threadsReducer } from './state';

import type { Thread, ThreadsAction, ThreadsState, Turn } from './state';
import type { AskResponse } from '@agent-works/domain';

const response: AskResponse = {
  requestId: 'response-1',
  answer: 'Seven of eight claims held.',
  citations: [],
};

const otherResponse: AskResponse = {
  requestId: 'response-2',
  answer: 'The rollback is ready.',
  citations: [],
};

const openFirst: ThreadsAction = { type: 'thread/opened', threadId: 'thread-1' };
const openSecond: ThreadsAction = { type: 'thread/opened', threadId: 'thread-2' };

function ask(threadId: string, requestId: string, question: string): ThreadsAction {
  return { type: 'turn/asked', threadId, requestId, question };
}

function apply(actions: readonly ThreadsAction[]): ThreadsState {
  return actions.reduce(threadsReducer, initialThreadsState);
}

const opened = apply([openFirst]);
const pending = apply([openFirst, ask('thread-1', 'request-1', '  What is the launch plan?  ')]);
const answered = apply([
  openFirst,
  ask('thread-1', 'request-1', '  What is the launch plan?  '),
  { type: 'turn/answered', requestId: 'request-1', response },
]);
const failed = apply([
  openFirst,
  ask('thread-1', 'request-1', '  What is the launch plan?  '),
  { type: 'turn/failed', requestId: 'request-1', message: 'Retrieval failed.' },
]);

function threadById(state: ThreadsState, threadId: string): Thread {
  const thread = state.threads.find((item) => item.id === threadId);
  if (thread === undefined) {
    throw new Error(`Missing thread ${threadId}`);
  }
  return thread;
}

function turnAt(state: ThreadsState, threadId: string, requestId: string): Turn | undefined {
  return threadById(state, threadId).turns.find((turn) => turn.requestId === requestId);
}

describe('threadsReducer', () => {
  it('starts with no threads and no selection', () => {
    expect(initialThreadsState).toEqual({ threads: [], activeThreadId: null });
  });

  it('opens an empty thread and makes it active', () => {
    expect(opened).toEqual({
      threads: [{ id: 'thread-1', turns: [] }],
      activeThreadId: 'thread-1',
    });
    expect(initialThreadsState.threads).toEqual([]);
  });

  it('appends another opened thread and activates the new one', () => {
    expect(apply([openFirst, openSecond])).toEqual({
      threads: [
        { id: 'thread-1', turns: [] },
        { id: 'thread-2', turns: [] },
      ],
      activeThreadId: 'thread-2',
    });
  });

  it('selects an existing thread', () => {
    const state = apply([openFirst, openSecond, { type: 'thread/selected', threadId: 'thread-1' }]);
    expect(state.activeThreadId).toBe('thread-1');
    expect(state.threads.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2']);
  });

  it('appends a pending turn and activates that thread', () => {
    const state = apply([
      openFirst,
      openSecond,
      ask('thread-1', 'request-1', '  What is the launch plan?  '),
    ]);
    expect(state.activeThreadId).toBe('thread-1');
    expect(turnAt(state, 'thread-1', 'request-1')).toEqual({
      requestId: 'request-1',
      question: '  What is the launch plan?  ',
      state: { status: 'pending' },
    });
  });

  it('stores an answer only from pending and leaves the active thread alone', () => {
    const waiting = apply([
      openFirst,
      openSecond,
      ask('thread-1', 'request-1', 'What is the launch plan?'),
      { type: 'thread/selected', threadId: 'thread-2' },
    ]);
    const state = threadsReducer(waiting, {
      type: 'turn/answered',
      requestId: 'request-1',
      response,
    });
    expect(state.activeThreadId).toBe('thread-2');
    expect(turnAt(state, 'thread-1', 'request-1')?.state).toEqual({
      status: 'answered',
      response,
    });
  });

  it('stores a failure only from pending', () => {
    expect(turnAt(failed, 'thread-1', 'request-1')?.state).toEqual({
      status: 'failed',
      message: 'Retrieval failed.',
    });
  });

  it('creates the thread when a question is asked in one that is not listed', () => {
    const state = threadsReducer(opened, ask('thread-9', 'request-9', 'Hello'));
    expect(state).toEqual({
      threads: [
        { id: 'thread-1', turns: [] },
        {
          id: 'thread-9',
          turns: [{ requestId: 'request-9', question: 'Hello', state: { status: 'pending' } }],
        },
      ],
      activeThreadId: 'thread-9',
    });
  });

  it('retries a failure with a new request id and the same question', () => {
    const state = threadsReducer(failed, {
      type: 'turn/retried',
      requestId: 'request-1',
      nextRequestId: 'request-2',
    });
    expect(turnAt(state, 'thread-1', 'request-1')).toBeUndefined();
    expect(turnAt(state, 'thread-1', 'request-2')).toEqual({
      requestId: 'request-2',
      question: '  What is the launch plan?  ',
      state: { status: 'pending' },
    });
    expect(state.activeThreadId).toBe('thread-1');
  });

  it('returns the same state when a retry reuses the current request id', () => {
    expect(
      threadsReducer(failed, {
        type: 'turn/retried',
        requestId: 'request-1',
        nextRequestId: 'request-1',
      }),
    ).toBe(failed);
  });

  it('answers one pending turn without touching another', () => {
    const waiting = apply([
      openFirst,
      ask('thread-1', 'request-1', 'First'),
      ask('thread-1', 'request-2', 'Second'),
    ]);
    const state = threadsReducer(waiting, {
      type: 'turn/answered',
      requestId: 'request-2',
      response: otherResponse,
    });
    expect(turnAt(state, 'thread-1', 'request-1')?.state).toEqual({ status: 'pending' });
    expect(turnAt(state, 'thread-1', 'request-2')?.state).toEqual({
      status: 'answered',
      response: otherResponse,
    });
  });

  it('ignores an answer for the request id a retry replaced', () => {
    const retried = threadsReducer(failed, {
      type: 'turn/retried',
      requestId: 'request-1',
      nextRequestId: 'request-2',
    });
    expect(
      threadsReducer(retried, { type: 'turn/answered', requestId: 'request-1', response }),
    ).toBe(retried);
  });
});

describe('illegal transitions', () => {
  const collided = apply([
    openFirst,
    ask('thread-1', 'request-1', 'First'),
    ask('thread-1', 'request-2', 'Second'),
    { type: 'turn/failed', requestId: 'request-1', message: 'Retrieval failed.' },
  ]);

  const cases: readonly {
    readonly name: string;
    readonly state: ThreadsState;
    readonly action: ThreadsAction;
  }[] = [
    {
      name: 'opening a duplicate thread',
      state: opened,
      action: { type: 'thread/opened', threadId: 'thread-1' },
    },
    {
      name: 'selecting a missing thread',
      state: opened,
      action: { type: 'thread/selected', threadId: 'missing' },
    },
    {
      name: 'selecting the active thread',
      state: opened,
      action: { type: 'thread/selected', threadId: 'thread-1' },
    },
    {
      name: 'asking with a request id already in use',
      state: pending,
      action: ask('thread-1', 'request-1', 'Again'),
    },
    {
      name: 'answering an unknown request',
      state: pending,
      action: { type: 'turn/answered', requestId: 'missing', response },
    },
    {
      name: 'failing an unknown request',
      state: pending,
      action: { type: 'turn/failed', requestId: 'missing', message: 'Retrieval failed.' },
    },
    {
      name: 'retrying an unknown request',
      state: pending,
      action: { type: 'turn/retried', requestId: 'missing', nextRequestId: 'request-9' },
    },
    {
      name: 'answering a turn that already answered',
      state: answered,
      action: { type: 'turn/answered', requestId: 'request-1', response: otherResponse },
    },
    {
      name: 'failing a turn that already answered',
      state: answered,
      action: { type: 'turn/failed', requestId: 'request-1', message: 'Retrieval failed.' },
    },
    {
      name: 'retrying a turn that already answered',
      state: answered,
      action: { type: 'turn/retried', requestId: 'request-1', nextRequestId: 'request-9' },
    },
    {
      name: 'answering a failed turn',
      state: failed,
      action: { type: 'turn/answered', requestId: 'request-1', response },
    },
    {
      name: 'failing a failed turn',
      state: failed,
      action: { type: 'turn/failed', requestId: 'request-1', message: 'Again' },
    },
    {
      name: 'retrying a pending turn',
      state: pending,
      action: { type: 'turn/retried', requestId: 'request-1', nextRequestId: 'request-9' },
    },
    {
      name: 'retrying onto a request id already in use',
      state: collided,
      action: { type: 'turn/retried', requestId: 'request-1', nextRequestId: 'request-2' },
    },
  ];

  it.each(cases)('$name returns the same state', ({ state, action }) => {
    expect(threadsReducer(state, action)).toBe(state);
  });
});

describe('threadTitle', () => {
  it('uses the trimmed first question', () => {
    expect(threadTitle(threadById(pending, 'thread-1'))).toBe('What is the launch plan?');
  });

  it('ignores later questions', () => {
    const state = apply([
      openFirst,
      ask('thread-1', 'request-1', 'First question'),
      ask('thread-1', 'request-2', 'Second question'),
    ]);
    expect(threadTitle(threadById(state, 'thread-1'))).toBe('First question');
  });

  it('names an empty thread New question', () => {
    expect(threadTitle(threadById(opened, 'thread-1'))).toBe('New question');
  });
});

describe('threadPreview', () => {
  it('is empty until a turn exists', () => {
    expect(threadPreview(threadById(opened, 'thread-1'))).toBe('');
  });

  it('reports a pending search', () => {
    expect(threadPreview(threadById(pending, 'thread-1'))).toBe('Searching the documents');
  });

  it('reports the answer text', () => {
    expect(threadPreview(threadById(answered, 'thread-1'))).toBe('Seven of eight claims held.');
  });

  it('reports the failure message', () => {
    expect(threadPreview(threadById(failed, 'thread-1'))).toBe('Retrieval failed.');
  });
});

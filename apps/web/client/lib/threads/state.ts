import type { AskResponse } from '@agent-works/domain';

type TurnState =
  | { readonly status: 'pending' }
  | { readonly status: 'answered'; readonly response: AskResponse }
  | { readonly status: 'failed'; readonly message: string };

export type Turn = {
  readonly requestId: string;
  readonly question: string;
  readonly state: TurnState;
};

export type Thread = {
  readonly id: string;
  readonly turns: readonly Turn[];
};

export type ThreadsState = {
  readonly threads: readonly Thread[];
  readonly activeThreadId: string | null;
};

export type ThreadsAction =
  | { readonly type: 'thread/opened'; readonly threadId: string }
  | { readonly type: 'thread/selected'; readonly threadId: string }
  | {
      readonly type: 'turn/asked';
      readonly threadId: string;
      readonly requestId: string;
      readonly question: string;
    }
  | { readonly type: 'turn/answered'; readonly requestId: string; readonly response: AskResponse }
  | { readonly type: 'turn/failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'turn/retried'; readonly requestId: string; readonly nextRequestId: string };

export const initialThreadsState: ThreadsState = {
  threads: [],
  activeThreadId: null,
};

const untitledThread = 'New question';

export const pendingCopy = 'Searching the documents';

export function threadTitle(thread: Thread): string {
  const question = thread.turns[0]?.question.trim() ?? '';
  return question === '' ? untitledThread : question;
}

export function threadPreview(thread: Thread): string {
  const latest = thread.turns.at(-1);
  if (latest === undefined) {
    return '';
  }
  switch (latest.state.status) {
    case 'pending':
      return pendingCopy;
    case 'answered':
      return latest.state.response.answer.trim();
    case 'failed':
      return latest.state.message;
    default: {
      const unreachable: never = latest.state;
      return unreachable;
    }
  }
}

export function findThread(state: ThreadsState, id: string): Thread | undefined {
  return state.threads.find((thread) => thread.id === id);
}

type LocatedTurn = {
  readonly thread: Thread;
  readonly threadIndex: number;
  readonly turnIndex: number;
  readonly turn: Turn;
};

export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case 'thread/opened':
      return openThread(state, action.threadId);
    case 'thread/selected':
      return selectThread(state, action.threadId);
    case 'turn/asked':
      return askTurn(state, action.threadId, action.requestId, action.question);
    case 'turn/answered':
      return settle(state, action.requestId, (turn) =>
        turn.state.status === 'pending' ? answeredTurn(turn, action.response) : undefined,
      );
    case 'turn/failed':
      return settle(state, action.requestId, (turn) =>
        turn.state.status === 'pending' ? failedTurn(turn, action.message) : undefined,
      );
    case 'turn/retried':
      return retryTurn(state, action.requestId, action.nextRequestId);
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

function openThread(state: ThreadsState, threadId: string): ThreadsState {
  if (findThread(state, threadId) !== undefined) {
    return state;
  }
  return {
    threads: [...state.threads, { id: threadId, turns: [] }],
    activeThreadId: threadId,
  };
}

function selectThread(state: ThreadsState, threadId: string): ThreadsState {
  if (state.activeThreadId === threadId) {
    return state;
  }
  if (findThread(state, threadId) === undefined) {
    return state;
  }
  return { ...state, activeThreadId: threadId };
}

function askTurn(
  state: ThreadsState,
  threadId: string,
  requestId: string,
  question: string,
): ThreadsState {
  if (requestIdExists(state, requestId)) {
    return state;
  }
  const turn: Turn = { requestId, question, state: { status: 'pending' } };
  if (findThread(state, threadId) === undefined) {
    return {
      threads: [...state.threads, { id: threadId, turns: [turn] }],
      activeThreadId: threadId,
    };
  }
  return {
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, turns: [...thread.turns, turn] } : thread,
    ),
    activeThreadId: threadId,
  };
}

function retryTurn(state: ThreadsState, requestId: string, nextRequestId: string): ThreadsState {
  if (requestIdExists(state, nextRequestId)) {
    return state;
  }
  return settle(state, requestId, (turn) =>
    turn.state.status === 'failed' ? pendingTurn(turn, nextRequestId) : undefined,
  );
}

function settle(
  state: ThreadsState,
  requestId: string,
  next: (turn: Turn) => Turn | undefined,
): ThreadsState {
  const located = findTurn(state, requestId);
  if (located === undefined) {
    return state;
  }
  const updated = next(located.turn);
  if (updated === undefined) {
    return state;
  }
  const turns = replaceAt(located.thread.turns, located.turnIndex, updated);
  const threads = replaceAt(state.threads, located.threadIndex, { ...located.thread, turns });
  return { ...state, threads };
}

function findTurn(state: ThreadsState, requestId: string): LocatedTurn | undefined {
  for (const [threadIndex, thread] of state.threads.entries()) {
    for (const [turnIndex, turn] of thread.turns.entries()) {
      if (turn.requestId === requestId) {
        return { thread, threadIndex, turnIndex, turn };
      }
    }
  }
  return undefined;
}

function requestIdExists(state: ThreadsState, requestId: string): boolean {
  return findTurn(state, requestId) !== undefined;
}

function answeredTurn(turn: Turn, response: AskResponse): Turn {
  return { ...turn, state: { status: 'answered', response } };
}

function failedTurn(turn: Turn, message: string): Turn {
  return { ...turn, state: { status: 'failed', message } };
}

function pendingTurn(turn: Turn, requestId: string): Turn {
  return { ...turn, requestId, state: { status: 'pending' } };
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = items.slice();
  next.splice(index, 1, item);
  return next;
}

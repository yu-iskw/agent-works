---
name: web-data-access
description: >-
  Routes browser writes through one fetch, the thread reducer, and POST
  /api/ask with JSON body {requestId, question}. Use when a screen under
  apps/web/client posts a question, mints a requestId, changes
  lib/threads/state.ts, or adds fetch or a mutation. Do not use for the shell
  layout, for the Button lookup tables, or for apps/web/app/web-app.ts.
---

# Web data access

## Purpose

One `fetch` posts Ask. A pure reducer in `apps/web/client/lib/threads/state.ts` holds threads. The caller mints one `requestId` per attempt. The shell that renders those threads is [web-screen-layout](../web-screen-layout/SKILL.md). The shared Button and its variant and size lookup tables live there too.

## The shape

Browser data access goes in these files. Do not add a second place for the same job.

- `apps/web/client/lib/client.ts` is the only `fetch`. `postJson` calls the web server. It does not call `apps/api`.
- `apps/web/client/query-client.ts` holds the one `QueryClient`.
- `apps/web/client/lib/ask/mutations.ts` exports `askMutationOptions()`. That factory takes no argument. Ask has no cached read, so the factory does not invalidate.
- `apps/web/client/lib/threads/state.ts` is the pure reducer. `apps/web/client/app.tsx` holds it with `useReducer`. Nothing writes threads to storage.

`apps/web/app/web-app.ts` is the only caller of `apps/api`. Browser code does not import that package.

The only entity directory today is `apps/web/client/lib/ask`. There is no `queries.ts`. Do not add a directory for any other noun.

`POST /api/ask` sends JSON `{requestId, question}`. `requestId` is a UUID the caller minted for that attempt. `question` is the trimmed question, from 1 to 1000 characters.

The screen states are empty, pending, answered, and failed. Empty means the thread has no turns. A turn in the reducer is pending, answered, or failed. These are the transitions.

- `thread/opened` adds an empty thread and activates it when the id is new.
- `thread/selected` sets the active thread when that thread exists and is not already active.
- `turn/asked` appends a pending turn when the thread exists and the `requestId` is new.
- `turn/answered` moves that turn from pending to answered.
- `turn/failed` moves that turn from pending to failed.
- `turn/retried` moves a failed turn back to pending and replaces `requestId` with `nextRequestId`.

Retry is the only path back to pending. Any other action returns the same state. That includes answering or failing a turn that is not pending, retrying a turn that is not failed, and retrying onto a `requestId` that is already in use.

Thread history is in memory only and is lost on reload. This is a known limit. `initialThreadsState` is an empty list and a null active thread. Theme preference is stored in `localStorage`. Threads stay in the reducer.

The server maps an upstream failure to a sentence. On any status other than 200, the client shows that sentence when the payload has a string `message`. The client uses its own sentence in three cases. A throw from `postJson`, including a thrown `fetch`, shows "The service is unavailable." A 200 payload that is not an ask response shows "The ask failed." Any other payload without a string `message` shows "The ask failed." The client does not show an HTTP status code. The client does not recompute authorization.

## Procedures

### 1. Post a question

1. Mint `requestId` in the caller with `crypto.randomUUID()`. One id per attempt. The reducer does not mint ids.
2. When no thread is active, dispatch `thread/opened` with a new thread id first.
3. Dispatch `turn/asked` with the thread id, the `requestId`, and the question.
4. Call `ask.mutate` with `{requestId, question}`. `postAsk` posts that object to `/api/ask` through `postJson`.
5. On success, dispatch `turn/answered` with `variables.requestId` and the response. On error, dispatch `turn/failed` with `variables.requestId` and `error.message`.

### 2. Retry a failed turn

1. Mint a new `requestId` in the caller. Pass the failed turn's id as `requestId` and the new id as `nextRequestId`.
2. Dispatch `turn/retried` before `ask.mutate`.
3. Mutate with the new id and the same question. The body is still `{requestId, question}`.

### 3. Render the turn

1. Read the turn from the reducer. Do not read `mutation.isPending` to decide the turn.
2. A thread with no turns is empty. The conversation shows the empty heading.
3. Pending shows a status line with `role=status` and the text Searching the documents.
4. Answered shows `response.answer`, and the source list when `citations` is not empty.
5. Failed shows `state.message` with `role=alert` and the Try again button. Try again is procedure 2.
6. `askMutationOptions()` takes no argument and does not invalidate. A posted question has no cache.

## Decision tree

- A new question uses procedure 1, then procedure 3.
- Try again on a failed turn uses procedure 2, then procedure 3.
- A change to a transition starts in `lib/threads/state.ts` and then checks `app.tsx`.
- The shell, the Button, or a lookup table key belongs to web-screen-layout.
- A change in `apps/web/app/web-app.ts` is server work. This skill does not move `fetch` into a second browser helper.

## Red flags

| Signal                                           | Meaning                                         | What to do instead                                                                    |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fetch` outside `apps/web/client/lib/client.ts`  | A second transport                              | Call `postJson` from `ask/mutations.ts`                                               |
| A browser call to `apps/api`                     | Browser code called `apps/api`                  | Call the web server. Leave `apps/api` to `web-app.ts`                                 |
| A new `QueryClient` outside `query-client.ts`    | A second cache                                  | Import the singleton                                                                  |
| `invalidateQueries` after Ask                    | Ask has no cached read                          | Leave the cache alone                                                                 |
| `mutation.isPending` choosing the turn           | The mutation flag stands in for the turn status | Read the turn status from the reducer                                                 |
| Idle, error, or success as a turn status         | The reducer uses different status names         | Use empty, pending, answered, and failed                                              |
| Pending that renders nothing                     | The status line is missing                      | Render Searching the documents with `role=status`                                     |
| A retry that reuses the failed `requestId`       | Two attempts share one id                       | Mint a new `requestId` in the caller and pass it as `nextRequestId`                   |
| The reducer minting a `requestId`                | The caller no longer owns the attempt id        | Mint the id in `app.tsx` and pass it in the action                                    |
| A path back to pending other than `turn/retried` | Answered or failed could become pending         | Retry is the only path back to pending                                                |
| Threads written to storage                       | Reload would keep history                       | Keep the reducer in memory. A reload clears it                                        |
| A status code in the UI                          | The screen shows transport detail               | Show the server `message`, or the client sentence from The shape                      |
| The client rewriting a server `message`          | The client replaced a sentence the server wrote | Show the string `message`. Use a client sentence only in the three cases in The shape |

## Error handling

A person sees a status code or a raw error name. Show the server `message` when the payload has a string `message`. Use "The service is unavailable." when `postJson` throws. Use "The ask failed." when a 200 payload is not an ask response, or when the payload has no string `message`.

A late answer arrives for the `requestId` a retry replaced. The reducer returns the same state. Dispatch with `variables.requestId` so the old attempt does not write the new turn.

Try again leaves the turn failed. The action was not `turn/retried`, or the next id was already in use. Mint a new id and dispatch `turn/retried` while the turn is failed.

Ask does not refresh a list after a successful post. That is expected. There is no cached Ask read to invalidate.

A reload still shows the previous questions. Thread history was written to storage. Remove that write. The empty sidebar tells the person that questions last until reload.

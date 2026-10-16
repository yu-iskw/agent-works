---
name: web-data-access
description: >-
  Routes browser reads and writes through one fetch and TanStack Query
  factories. Use when a screen under apps/web/client loads or changes server
  data, or when a diff adds fetch or a query key. Do not use for page layout,
  for apps/web/app/web-app.ts, or for rewriting sentences the server already
  returns.
---

# Web data access

## Purpose

One `fetch` and one `QueryClient` serve every browser read and write. Screens call factories. A component never calls `fetch` and never writes a query key inline.

Page layout is [web-screen-layout](../web-screen-layout/SKILL.md).

## The shape

Browser data access goes in these files. Create a missing file in this shape. Do not add a second place for the same job.

- `apps/web/client/lib/client.ts` is the only `fetch`. It calls the web server. It does not call `apps/api`.
- `apps/web/client/query-client.ts` holds the one `QueryClient`.
- `apps/web/client/lib/<entity>/queries.ts` exports `queryOptions` factories for reads.
- `apps/web/client/lib/<entity>/mutations.ts` exports `mutationOptions` factories for writes. `askMutationOptions()` takes no argument. A factory that invalidates a cached read takes the `QueryClient`.

`apps/web/app/web-app.ts` is the only caller of `apps/api`. Browser code does not import that package.

An entity directory uses a noun this product has. The only entity directory today is `apps/web/client/lib/ask`. Citations and the Sources heading are on the Ask screen. They are not entity directories. Tasks and approvals are planned in [RFC-001](../../../docs/rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md). Do not add a directory for any other noun.

The server maps an upstream failure to a sentence. `apps/web/app/web-app.ts` already does this for Ask, as in "Sign in required." On any status other than 200, the client shows that sentence when the payload has a string `message`. The client uses its own sentence in three cases. A throw from `postJson`, including a thrown `fetch`, shows "The service is unavailable." A 200 payload that is not an ask response shows "The ask failed." Any other payload without a string `message` shows "The ask failed." The client does not show an HTTP status code.

A read type includes the authorization flags the server decided. The client renders the flag. It does not recompute who may act. A read type never includes a secret. Secrets are write-only.

## Procedures

### 1. Add a read

1. Create or open `apps/web/client/lib/<entity>/queries.ts`.
2. Declare the type the browser receives.
3. Put the server authorization flags on that type. Do not recompute them from other fields.
4. Leave secrets out. A secret is accepted on a write and is not read back.
5. Export one key factory. The root key is the entity name. A list key appends its parameters so two filters are two cache entries. The `tasks` names below are the shape to copy. That module is not in the tree.

```ts
export const taskKeys = {
  all: ['tasks'] as const,
  list: (status: string) => ['tasks', 'list', { status }] as const,
};
```

6. Export a `queryOptions` factory named for the subject, as in `taskListQueryOptions`. The `queryFn` calls `client.ts`.
7. A component calls `useQuery` with that factory. It does not pass its own `queryKey`.

### 2. Add a write

1. Create or open `apps/web/client/lib/<entity>/mutations.ts`.
2. Export a `mutationOptions` factory named for the verb and the entity, as in `updateTaskMutationOptions`. A factory that invalidates a cached read takes the `QueryClient`. `askMutationOptions()` takes no argument.
3. The `mutationFn` calls `client.ts`.
4. After a write that changes cached data, invalidate the entity root key so every cached read for that entity refreshes.

```ts
onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.all });
```

5. Do not patch the cache by hand. A patched entry guesses fields the server computed.
6. The Ask write has no cached read. Posting a question returns an answer and citations for that turn. `askMutationOptions()` takes no argument and does not invalidate, because a posted question has no cache.

### 3. Render the result

1. Ask calls `useMutation(askMutationOptions())`. It does not pass a `QueryClient`. The one `QueryClient` lives in `apps/web/client/query-client.ts`. Do not construct another. A write that invalidates a cached read imports that client and passes it into its factory.
2. Ask branches in this order. Idle, then pending, then error, then success. Idle and pending render nothing. Error shows the message. Success shows the answer, and the citations when that list is not empty.
3. Pending renders nothing. No spinner, no skeleton, and no Loading text. The heading is already on screen.
4. A list read does not exist yet. When one does, branch pending, then error, then empty, then rows. Keep pending first. Removing it shows the empty sentence during the fetch, and that sentence is false.
5. On any status other than 200, the error branch shows the server message when the payload has a string `message`. It uses the client sentence when `postJson` throws, when a 200 payload is not an ask response, or when the payload has no string `message`. It does not show a status code.
6. The Ask button says Asking… while that mutation is pending, and Ask otherwise. The label is feedback for the press. It is not a placeholder for a read. Read it from `mutation.isPending`. A later write may say Saving the same way.

## Decision tree

- A screen that displays server data uses procedure 1, then procedure 3.
- A create, update, or delete of cached data uses procedure 2, then procedure 3.
- The Ask write uses procedure 2. The factory takes no argument and does not invalidate, because a posted question has no cache.
- A changed payload type starts at procedure 1 and then checks every consumer of that type.
- A new width or a settings row belongs to web-screen-layout.
- A change in `apps/web/app/web-app.ts` is server work. This skill does not move `fetch` into the browser.

## Red flags

| Signal                                                     | Meaning                                                | What to do instead                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch` outside `apps/web/client/lib/client.ts`            | A second transport, or a read with no key              | Call `client.ts` from a factory                                                                                                                                      |
| A browser call to `apps/api`                               | Browser code called `apps/api`                         | Call the web server. Leave `apps/api` to `web-app.ts`                                                                                                                |
| `useQuery` with an inline `queryKey`                       | Invalidation will miss the cache entry                 | Call the `queryOptions` factory                                                                                                                                      |
| A new `QueryClient` outside `query-client.ts`              | A second cache                                         | Import the singleton                                                                                                                                                 |
| `setQueryData` after a mutation                            | A guess at server fields                               | Invalidate the entity root key                                                                                                                                       |
| `invalidateQueries` after Ask                              | Ask has no cached read                                 | Leave the cache alone                                                                                                                                                |
| A spinner, a skeleton, or Loading while a query is pending | A placeholder stands in for the answer                 | Render nothing from the pending branch                                                                                                                               |
| The pending branch removed on a list read                  | The empty sentence shows during the fetch              | Keep pending first and render nothing                                                                                                                                |
| A status code in the UI                                    | The screen shows transport detail                      | Show the server message, or the client sentence when `postJson` throws, when a 200 payload is not an ask response, or when the payload has no string `message`       |
| Client code replacing a server `message`                   | The client rewrote a sentence the server already wrote | Show the string `message`. Use a client sentence only when `postJson` throws, when a 200 payload is not an ask response, or when the payload has no string `message` |
| A component deciding a control from a role and an owner    | The client repeated a rule the server already decided  | Render the server flag                                                                                                                                               |
| A token or secret on a read type                           | A read returned a secret                               | Accept the secret on the write only                                                                                                                                  |

## Error handling

The list stays stale after a write. The invalidated key and the query key differ. Both come from the same factory. Invalidate the entity root.

On a list read, the empty sentence flashes, then the rows appear. The pending branch is missing or is not first. Put it first and render nothing.

A person sees a status code or a raw error name. Show the server message when the payload has a string `message`. Use the client sentence when `postJson` throws, when a 200 payload is not an ask response, or when the payload has no string `message`.

Ask does not refresh a list after a successful post. That is expected. There is no cached Ask read to invalidate.

Two filters share one cache entry. The list key omitted the filter. Put the filter on the list key.

A button stays on Asking or Saving after the write settles. The label comes from component state. Read the mutation pending flag.

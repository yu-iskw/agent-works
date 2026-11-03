# SCH-03 queue delivery

Code: `apps/api/src/queue/**` (unwired). Envelope is the frozen v1 in `packages/domain/src/dispatch-envelope.ts`.

## Producer

`createCloudTasksQueue(config, client).enqueue(envelope)` posts one Cloud Tasks `tasks.create` through the `QueueHttpClient` port. The task name is `…/tasks/d-<sha256(dispatchId)>`, so a republish returns 409, reported as `duplicate`, not an error. The body is the serialized envelope and nothing else. The task carries `oidcToken {serviceAccountEmail, audience = worker URL}` and `dispatchDeadline` (validated 15 s to 29 min, below the 30 min cap). 5xx, 408, 429 and transport errors throw `EnqueueFailed(retryable: true)` for the outbox publisher to back off; other 4xx are permanent. Retry (`maxAttempts`, backoff, doublings, duration) and backpressure (`maxDispatchesPerSecond`, `maxConcurrentDispatches`) are typed values; `backoffSeconds` is capped exponential with jitter in `[cap/2, cap]`. The production `QueueHttpClient` (access token for the enqueuing identity) is wiring, not in this change.

## Consumer: `createDeliveryHandler(deps)(request)`

| Condition                                                                                          | Status | Why                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| No/ malformed bearer, bad signature or key, wrong alg, issuer, audience, expired, unverified email | 401    | Not retried usefully; fails closed before any DB access                                       |
| Valid token, principal outside the allowlist                                                       | 403    | Authorization denied                                                                          |
| Key set fetch failed                                                                               | 503    | Transient                                                                                     |
| Envelope `unsupported-version` (newer)                                                             | 503    | Retryable per contract so a newer revision can serve it                                       |
| Malformed, oversize, unknown field, version 0                                                      | 200    | Permanent poison. Acknowledged only after `recordRejected` committed; if recording fails, 503 |
| `handoff` throws                                                                                   | 503    | Nothing committed                                                                             |
| `handoff` = `accepted`                                                                             | 200    | Durable commit done before the response                                                       |
| `handoff` = `already-terminal`                                                                     | 200    | Duplicate delivery of a finished execution                                                    |
| `handoff` = `in-progress`                                                                          | 503    | Redeliver after backoff; sees terminal or reconciler acts                                     |
| `handoff` = `unknown-execution`                                                                    | 503    | May be visibility lag; bounded by queue `maxAttempts`                                         |

The handler awaits the store and starts no detached work, so no 2xx precedes the durable handoff. `DeliveryStore.handoff` resolves `executionId` in the database; fence and lease come from that claim, never the message.

Signature check: `createRs256JwksVerifier` (node:crypto, no new dependency; the repo has no jose). RS256 only, `kid` lookup, 5 s refetch floor on unknown kid, injectable `fetch`. Claims go through the existing `verifyServiceClaims`.

## Wiring for the coordinator

1. Mount a POST route (for example `/internal/deliveries`, outside the IAP-fronted routes) in `server.ts` calling `createDeliveryHandler({ verifyIdToken: createRs256JwksVerifier(), policy: createServiceIdentityPolicy({ audience: <worker URL>, authorizedEmails: [dispatcher SA] }), store })`, passing the raw body and `Authorization` header, replying with `status`.
2. Implement `DeliveryStore` over Postgres: `handoff` = in one transaction look up the execution by id, return `already-terminal` for terminal states, otherwise commit the lease/claim row and return `accepted`.
3. Implement `QueueHttpClient` over `google-auth-library` (already a dependency) and call `enqueue` from the SCH-01 outbox publisher.
4. Terraform: instantiate `infra/terraform/modules/task_queue` from a root (not done here).

## Compatibility and rollback

No migration; additive and unwired. Rollback is deleting the new files. Adding envelope v2 follows the contract rollout order (readers first).

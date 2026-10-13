# Google Docs write contract

This file is the design contract for GitHub issue 103. It does not implement a tool, and it does not close an open decision. [ADR 0003](../adr/0003-pilot-decisions.md) is Accepted. Its text is "The first real write is a Google Docs draft in a shared drive. The fake ticket tool stays for CI. No write tool is built under this record." [RFC-001](../rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md) is Proposed, and it is not an Accepted ADR. The public effects are `stop`, `replay`, and `post_once`. `post_once` matches only when no deny row, no hold row, and no `replay` row matches. A stored matching receipt is `replay`, not a second post. This contract grants no scope and creates no document. Operators sign off before any real write. The [Negative matrix](google-docs-write-negative-matrix.md) prints the same Id, Kind, Result, and When cells, and it adds a Source column.

## Attempt record

The attempt record is immutable. It reuses existing types and does not define a second approval object.

`Approval` in `packages/domain/src/approval.ts` has `id`, `taskId`, `stepId`, `tool`, `targetResource`, `payloadSha256`, `requestedBySub`, `approverSub`, `state`, `expiresAt`, `maxExecutions`, and `executionsUsed`.

`Authority` in `packages/domain/src/authority.ts` has `kind`, `scopes`, `resourceConstraint`, `expiresAt`, and `auditRef`. `kind` is `userDelegated`, `agentOwned`, or `approvedServiceWorkflow`. `scopes` is an array of non-empty strings. RFC-001 section 5.2 spells the kinds `user_delegated`, `agent_owned`, and `approved_service_workflow`. The names in this contract are the schema names.

A human principal and an agent principal come from `packages/domain/src/principal.ts` and from `contracts/schemas/principal.json`. The human fields are `sub`, `enterpriseId`, `email`, `groups`, and `groupsObservedAt`. The agent fields are `agentId`, `version`, and `identityRef`.

RFC-001 section 5.2 records three principals on every business action. Here the human is `actor_user`, and the agent is `actor_agent`. `authority` for this write is `userDelegated`, plus `scopes`, `resourceConstraint`, `expiresAt`, and `auditRef`.

Section 5.3 keeps IAP separate from Workspace API access. IAP does not grant Drive or Docs. Domain-wide delegation stays out of scope by default. A Cloud service account is not a personal Drive owner.

`idempotencyKey` and `externalReceipt` come from the tool call in `packages/domain/src/tool-call.ts`. `requestDigestSha256` and `externalObjectRef` already exist on the audit event in `packages/domain/src/audit-event.ts`. This contract does not define a new audit event.

A separate state-machine lifecycle is not part of this contract.

## Consent and scopes

Consent is the user-delegated OAuth grant that precedes execution. Section 5.3 specifies 3-legged OAuth, requests permissions when the user first invokes the matching feature, and includes a revocation path. Raw OAuth credentials stay out of prompts, chat histories, traces, and exposed agent tool results under section 5.3.

`scopes` remains the string array on `Authority`. No scope URI is named. D-07 is open, so the row `scope_fork` holds and the result is `oauth_scope_unresolved`.

## Target and recipients

ADR 0003 states "The first real write is a Google Docs draft in a shared drive." RFC-001 section 10.4 states "Google Docs draft output into a user-authorized or team Shared Drive destination." `destination_fork` stays open. Its result is `destination_unresolved`.

Section 7.4 names the disclosure fields as recipients, permissions, file attachments, the target environment, and cost where applicable.

`targetResource` stays the approval string. Comparison of `resourceConstraint` with `targetResource` is not in this contract.

## Canonical digest and approval binding

The digest is the lowercase 64-hex SHA-256 that `canonicalPayloadSha256` returns in `packages/domain/src/canonical-hash.ts`. The approval field name stays `payloadSha256`.

Section 7.4 names `task_id`, `step_id`, `tool`, the target resource, the canonical payload hash, the approver user id, expiry, and the permitted execution count. The schema stores `taskId`, `stepId`, `tool`, `targetResource`, `payloadSha256`, `approverSub`, `expiresAt`, and `maxExecutions`.

Section 7.4 says a material change to the payload, the target, the classification, or the policy version invalidates the approval. A payload change matches `digest_mutation`. When no receipt is stored, a target, classification, or policy-version change matches `approval_invalidated`.

Single-use is the normal case. The security and broker fixtures set `maxExecutions` to 1. The schema allows a larger cap. This contract does not raise the cap.

## Execution-time reauthorization

Execution-time reauthorization is the second evaluation of identity, source permissions, and policy. Sections 5.2, 7.3, and 7.4 require that evaluation at execution time. The Phase 2 gate in section 18 requires a complete task that can be approved, reauthorized, safely retried, and reconciled in audit logs. The evaluation is not a second consent screen.

`recheck_missing` denies a new post when the caller asks to execute, the receipt is absent, and the execution recheck is absent. `recheck_denied` denies a new post when the recheck is present, the receipt is absent, and identity, policy, or approver authority failed.

## Idempotency, receipt, and audit

Section 7.4 specifies a unique idempotency key persisted before the call, and a stored external side-effect receipt. No Docs idempotency method is specified. The attempt policy is at-most-once.

The shell persists the idempotency key in the existing claim transaction before the remote call. A concurrent caller that already sees that key and no receipt matches `timeout_after_write`.

When the shell already holds an external operation id, it stores that id as `externalReceipt` and as audit `externalObjectRef`. The next decision matches `replay`. A missing id stays on `timeout_after_write`. No Docs lookup method is named.

`replay` returns the stored receipt and does not post. `timeout_after_write` holds with `at_most_once_receipt_missing` and allows no second post.

The audit event keeps `requestDigestSha256` and `externalObjectRef`, and it contains no raw OAuth material.

`ticket.create` may still post again on an `INTENDED` resume. This contract does not change that tool. `apps/api/src/server.ts` does not call `blockIfStale`. This contract does not wire that call.

## Compensation

`no_docs_compensation` matches when the caller asks to compensate. No Docs undo is defined. The hold still applies when a receipt is stored.

Section 7.1 states that cancellation cannot undo a completed external write. Section 19.1 says to inspect the state and the idempotency receipt, and not to replay a completed write.

## Decision table

Every matching deny row or hold row contributes to `stop`. A matching `replay` row returns the stored receipt and does not post. `post_once` is what remains when no deny row, no hold row, and no `replay` row matches. Each When cell states whether that row requires an absent receipt.

| Id                       | Kind   | Result when it matches                                                                                                                                                                                                                                                      | When                                                                                                                                                                                                                     |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no_docs_compensation     | hold   | No Docs undo is defined.                                                                                                                                                                                                                                                    | The caller asks to compensate. This row still matches when a receipt is stored.                                                                                                                                          |
| digest_mutation          | deny   | The stored digest stays. On decide, a mismatched `expectedPayloadSha256` is 409 `stale_digest`. On claim, a different payload hash is `APPROVAL_REQUIRED`.                                                                                                                  | The digest now differs from `payloadSha256`, or from the digest stored with a receipt. This row still matches when a receipt is stored.                                                                                  |
| idempotency_key_mismatch | deny   | No replay and no new post.                                                                                                                                                                                                                                                  | A stored key is present and differs from this attempt's key. This row still matches when a receipt is stored.                                                                                                            |
| replay                   | replay | Return the stored receipt. Do not post.                                                                                                                                                                                                                                     | The caller asks to execute, a receipt is stored, the stored key equals this key, and the digest matches.                                                                                                                 |
| timeout_after_write      | hold   | `at_most_once_receipt_missing`. No second post.                                                                                                                                                                                                                             | The receipt is absent, and the key is already persisted or the shell cannot prove the remote call never started.                                                                                                         |
| self_approval            | deny   | Decide returns 403 `self_approval` when the requester approves their own pending row, and that row stays pending with `approverSub` null. Claim returns `APPROVAL_REQUIRED` when a stored `approverSub` equals `requestedBySub`. This contract does not relax either check. | The receipt is absent, and either the requester is approving their own pending row or a stored `approverSub` equals `requestedBySub`.                                                                                    |
| authorization_expiry     | deny   | No new post. An approval clock at or before now is `APPROVAL_EXPIRED`. Authority or OAuth expiry is the RFC `BLOCKED_AUTH` outcome.                                                                                                                                         | The receipt is absent and an applicable clock is less than or equal to now.                                                                                                                                              |
| user_or_group_revocation | deny   | No new post and no silent impersonation.                                                                                                                                                                                                                                    | The recheck is present, the receipt is absent, and the user or group evidence is revoked.                                                                                                                                |
| token_revocation         | deny   | No new post. The RFC outcome name is `BLOCKED_AUTH`.                                                                                                                                                                                                                        | The receipt is absent and the OAuth status is `revoked`.                                                                                                                                                                 |
| source_acl_denial        | deny   | No new post.                                                                                                                                                                                                                                                                | The recheck is present, the receipt is absent, and the source ACL denies the write.                                                                                                                                      |
| recheck_missing          | deny   | No new post.                                                                                                                                                                                                                                                                | The caller asks to execute, the receipt is absent, and the execution recheck is absent.                                                                                                                                  |
| recheck_denied           | deny   | No new post.                                                                                                                                                                                                                                                                | The recheck is present, the receipt is absent, and identity, policy, or approver authority failed.                                                                                                                       |
| consent_denied           | deny   | No new post.                                                                                                                                                                                                                                                                | The receipt is absent, and a consent check fails. A failing check is an authority kind other than `userDelegated`, an empty `scopes` array, or a missing OAuth connection. The scope strings themselves stay unresolved. |
| approval_invalidated     | deny   | No new post.                                                                                                                                                                                                                                                                | The receipt is absent, and the target, the classification, or the policy version changed after approval.                                                                                                                 |
| side_effect_blocked      | deny   | No new post.                                                                                                                                                                                                                                                                | The receipt is absent, and the side-effect class is not `WRITE_LOW`. `WRITE_HIGH` and `ADMIN` stay denied in the MVP.                                                                                                    |
| write_low_fork           | hold   | `write_low_policy_unresolved`.                                                                                                                                                                                                                                              | The receipt is absent, the class is `WRITE_LOW`, and the choice between approval and a narrowly scoped policy is unresolved.                                                                                             |
| destination_fork         | hold   | `destination_unresolved`.                                                                                                                                                                                                                                                   | The receipt is absent and the destination is unresolved.                                                                                                                                                                 |
| scope_fork               | hold   | `oauth_scope_unresolved`.                                                                                                                                                                                                                                                   | The receipt is absent and the accepted scope list is unresolved. This is D-07.                                                                                                                                           |
| dual_fork                | hold   | `d12_open`.                                                                                                                                                                                                                                                                 | The receipt is absent and dual approval is unresolved. `Approval` stores one `approverSub`.                                                                                                                              |
| schedule_fork            | hold   | `d11_open`.                                                                                                                                                                                                                                                                 | The receipt is absent, there is no direct user prompt, and unprompted work is unresolved.                                                                                                                                |
| acl_freshness            | hold   | `d05_open`.                                                                                                                                                                                                                                                                 | The receipt is absent, the recheck is present, and the user, group, or source ACL evidence is still unresolved.                                                                                                          |

## Open decisions

RFC-001 section 20 leaves D-05, D-07, D-11, and D-12 open. A hold row matches only when its When cell matches. `scope_fork` and `dual_fork` match when the receipt is absent and that fork is unresolved. `schedule_fork` also requires that there is no direct user prompt. `acl_freshness` also requires a recheck whose evidence is still unresolved. Section 10.2 records the `WRITE_LOW` default as approval or a narrowly scoped policy, and `write_low_fork` does not pick one. ADR 0003 names a shared drive. Section 10.4 names a user-authorized or team Shared Drive. `destination_fork` does not pick one.

`infra/terraform/environments/dev/tenant.tf` sets the reviewer member set to empty, so the file names no approver. Yu owns the pilot through C-05. No human user is bound in infrastructure until named owners exist. ADR 0003 builds no retrieval under that record, and it sets no spending cap.

## What this contract does not change

The `Approval` schema, the broker, and the OAuth routes stay as they are. `ticket.create` stays as it is. `readable` in `apps/api/src/retrieval/search.ts` filters Drive reads. That function is not a Docs write ACL.

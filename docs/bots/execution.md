# Durable bot execution

A bot run pins an immutable published revision and uses the owner's connections. Edits and later publication do not change that pin. Execution uses `wb_tasks`, `tw_bot_runs`, `tw_bot_steps`, and the existing `tw_jobs` queue. `AW_BOT_WORKFLOWS=on` enables the routes, migrations and job handler. With the flag off, bot routes return 404 and workers do not claim bot jobs.

## Identity and authority

`tw_bots.owner_email` binds the bot owner's subject to an email from an authenticated request. Owner commands refresh this binding. Publication also writes it through the integration hook in `bots/service.ts`. Background triggers never supply this email. An absent binding denies a start with `identity_unbound`. A member removed from the allowlist fails with `membership_revoked`; a read-only owner fails with `read_only_member`.

The run records its owner, initiator, and execution subject separately. Manual starts require the initiator to be the owner. Schedule and event initiators identify their trigger; execution still uses the owner's authority.

Before starting a run, starting a step, resuming a wait, sending an MCP submission, reading an external result, and committing a continuation, execution checks current membership, read-only status, the teammate's existence, segment capabilities, installations and connections, agent registry membership, skill activation and digest, and any standing grant. Checkpoint digests are checked again at continuation. A cancellation request is durable and prevents further work. A failed authority lookup fails closed.

Bot capabilities come from the revision's connector-read steps. Skill `allowed-tools` intersects that set. The model receives instructions and bounded input text; this adapter provides no model-initiated tool execution. Package scripts, hooks, commands and MCP configuration do not execute. Connector reads use the existing source adapter and token source after the authority check. Uploaded files are restricted to the execution owner's files in the bot's conversation.

## States and approvals

Normal run transitions use `canTransition('run', ...)` from the domain contract. Steps use `canTransition('step', ...)`. A run progresses through `queued`, `running`, waits for approval or an external task, and ends as `completed`, `failed`, `cancelled`, or `outcome_uncertain`. Ready steps execute serially in dependency order. This keeps one external effect in flight per run while preserving the definition's dependency graph.

A per-run approval binds the task ID, revision number, revision digest, capabilities and agents through a canonical SHA-256 digest. Checkpoints bind the task ID, checkpoint step, revision digest, definitions of immediate dependent steps, and their exact input values. Decisions require the owner, a pending unexpired row, and the matching action digest. A changed input produces `stale_approval`. Decline fails the run with `declined` and blocks downstream work. A decision arriving after cancellation is audited and cannot restart the run.

Standing grants use the existing `tw_standing_grants` store and lifecycle. The grant permission is the exact pair `bot.run` and the revision digest. The grantee is the teammate ID and revision; the sponsor is the owner. No child authority is issued. The existing budget's `inferenceSteps` stores `maxRuns`, and `estimatedCostMicros` stores the grant budget. `Number.MAX_SAFE_INTEGER` represents the API's null budget. Issuance and revocation retain the lifecycle's immutable grant and audit rules. The execution flag enables these bot-scoped grants; it does not enable unrelated grant consumers.

The explicit `ADMIN_TRANSITIONS` table defines the only administrative exceptions. Retry changes a failed step to ready, increments its attempt, creates a new submission key, and can reopen a failed run when no step is uncertain or cancelled. Retry rechecks authority and admission. Resolve changes an uncertain step to owner-asserted success or failure, stores the bounded note in the audit record, and marks `resolved_by_owner`. It never submits again. Resolved success has no output, so downstream consumers remain blocked with `resolved_without_output`. A cancellation permanently disables retry and resolve, including when remote cancellation left uncertainty.

## Idempotency and recovery

| Boundary                              | Durable intent                                       | Recovery action                                               |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Run start                             | Unique teammate and trigger reference                | Return the existing task ID for duplicate delivery            |
| Admission                             | Reservation execution ID equals task ID              | Reconcile lease expiry through the existing admission service |
| Step start                            | Running status, job owner token, exact inputs        | Reclaim expired job leases; fence the previous token          |
| MCP submission                        | `bot:<taskId>:<stepId>:<attempt>` before the request | Look up the key; never blindly resubmit                       |
| Accepted MCP task                     | Agent ID and external handle                         | Resume status polling with `run_after` backoff                |
| Lost submit response without lookup   | Uncertain step and run                               | Surface uncertainty and await owner resolution                |
| Model call interrupted by worker loss | Existing model-call ledger                           | Fail the interrupted step; require an explicit retry          |
| Step completion                       | Output, transition and next job in one transaction   | Continue from the committed graph                             |
| Approval                              | Bound `wb_approvals` row and inbox item              | Resume only after the valid owner decision                    |

Task, run, step, approval and initial job rows commit in one transaction. Admission reserves first; an insertion failure releases the holder. A crash between reservation and insertion leaves only a leased holder that the expiry sweep releases. Per-teammate admission starts serialize under an advisory lock so concurrent duplicate triggers see the committed run.

A job's lease token must still own a live lease to prepare or settle its step. Each external request is preceded by another ownership check. A stale holder cannot commit output or release dependent steps. Workers recover at startup and periodically. Recovery finds persisted external handles, resumes polling, checks approvals and authority, and renews live admission holders. Process loss between submission and handle persistence uses lookup on the persisted key. There is no automatic retry of an uncertain effect.

## Cancellation and external outcomes

Cancellation records `cancel_requested_at`, moves the run to `cancel_requested`, cancels unstarted steps, and voids approvals. The running handler finishes at a safe boundary. An accepted MCP task receives a cancellation request when supported. `external.cancel` records `requested`, `confirmed`, `unsupported`, or `uncertain`. Unsupported or unconfirmed cancellation ends the step and run as `outcome_uncertain`; it never claims that the remote effect stopped. A confirmed cancellation allows the run to become `cancelled`. A timeout uses the same remote-cancellation path.

Late results are recorded as ignored events when a handler receives them after cancellation. They cannot release dependent work or replace the result. Successful output is bounded to 32 KiB, checked for nonempty text, and stored only after authority and lease checks. Provider exception messages never enter run views or step error fields. Errors use fixed codes.

## Cost and admission

Concurrency uses the existing Postgres admission service with execution ID equal to task ID, bot ID equal to teammate ID, and member ID equal to the owner. Deployment admission policy (the `admission_limits` rows an operator configures) is applied as configured and never rewritten by a bot. A definition's `maxConcurrentRunsPerBot` and `maxConcurrentRunsPerUser` are ceilings checked in the transaction that inserts the run: active runs of the bot are counted under its `tw_bots` row lock and active runs of the owner, across all their bots, under a per-owner advisory lock. A start must pass both the policy and the ceilings, so a definition can only narrow. A denial from either refuses a manual start with `admission_denied`; schedule and event starts return `deferred` without creating a run. Terminal states release the holder. A five-minute admission lease reconciles crashed holders; live recovery renews it every ten seconds, and the job heartbeat renews it during a long step.

The cost view reads every sent model call from `wb_model_calls` and every MCP attempt, including prior failed attempts retained during retry. MCP USD amounts are reported cost. Missing reports and non-USD reports remain unknown. Model token usage remains in the ledger, but the repository's FinOps price table is explicitly `PLACEHOLDER`, so execution does not treat it as approved pricing. Model costs therefore appear as unknown items with `price_unavailable`. Missing amounts remain null. Completeness is complete only when every billable item is known; otherwise it is partial when some cost is reported, or unknown when none is known.

Before a paid step, execution checks the run ceiling and grant budget under the run lock and, for grants, the grant lock. Without a provider quote or approved model price, one unknown item reserves the remaining finite budget. A zero budget denies dispatch; a subsequent paid step cannot dispatch while earlier cost remains unknown. Uncapped runs may continue and display uncertainty. Remote reported cost arrives after dispatch and can exceed the remaining budget. This is an overshoot risk, not a guaranteed provider-side spending cap.

## Local configuration and operator recovery

Set `AW_BOT_WORKFLOWS=on`. Set `AW_BOT_MCP_AGENTS` to an operator-owned JSON registry file. A missing file produces an empty registry and a field-only warning; delegate definitions then fail validation. Invalid JSON or agent fields stop startup without printing configuration values. Local HTTP loopback requires `AW_BOT_MCP_ALLOW_LOOPBACK=on`, local-test identity, and a non-production process. Production uses HTTPS and the registry's host allowlist.

Curated packages load at startup. Activation is explicit through the comma-separated package IDs in `AW_BOT_ACTIVATE_CURATED`, for example `brief-writer`. Omitting the variable does not activate a newly loaded package. The demo package requests `files.read`; attach a small text file to the bot's conversation and use a files-read step before its skill. Register `reference-research-agent` using the reference server in `teamwork/mcp-task/reference-agent-server.ts`. Publish a matching revision, start a manual run, approve its checkpoints, and inspect the run and inbox routes. The runtime exposes `startBotRun` for the trigger coordinator.

For `outcome_uncertain`, inspect the remote agent's own task record before using the resolve route. Never retry a submission whose outcome is uncertain. For expired or revoked grants, issue a new grant for the published revision and start a new run. For worker loss, restart the worker and inspect the persisted handle and submission count; model steps interrupted by the loss need an explicit retry. For a stuck approval, inspect expiry, owner binding and action digest; expired approvals require a new run. To stop all new bot processing, disable `AW_BOT_WORKFLOWS` and restart the segment. Cancel active runs before disabling processing when remote cancellation is required.

For the loopback demo, build once and start the reference server in a separate terminal:

```sh
pnpm build
node apps/api/dist/teamwork/mcp-task/reference-agent-server.js --port 9097
```

A local registry file can contain:

```json
[
  {
    "agentId": "reference-research-agent",
    "displayName": "Local reference research agent",
    "protocol": "mcp",
    "contract": "aw.task.v1",
    "endpoint": "http://127.0.0.1:9097/mcp",
    "allowedHosts": ["127.0.0.1:9097"],
    "supports": {
      "cancel": true,
      "lookupByIdempotencyKey": true,
      "reportsCost": true
    },
    "maxInputBytes": 65536,
    "maxOutputBytes": 65536,
    "callTimeoutMs": 5000,
    "dataClassification": "INTERNAL"
  }
]
```

Point `AW_BOT_MCP_AGENTS` at that file and set `AW_BOT_MCP_ALLOW_LOOPBACK=on`, `AW_BOT_ACTIVATE_CURATED=brief-writer`, and `AW_BOT_WORKFLOWS=on` for a local-test segment. The complete Postgres and reference-agent exercise runs with `pnpm exec vitest run apps/api/src/teamwork/bots/execution/execution.test.ts`; it starts and stops its own dependencies.

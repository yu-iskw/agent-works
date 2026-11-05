# Teammate bots: operator handoff and Gate O

This milestone ships local, default-off code. Nothing here was deployed, no live flag was enabled, and no external service was called. Gate L (local proof) and Gate O (operator demonstrations) are separate; existing production release gates G1 to G4 remain NO-GO and are not changed by this work.

## Capability flags and configuration

Everything is read once at segment startup by `apps/api/src/teamwork/runtime.ts`. With `AW_BOT_WORKFLOWS` unset or not exactly `on`, none of the variables below is read, no bot migration runs and every bot route returns 404.

| Variable                    | Default        | Meaning                                                                                                                                                                                                         |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AW_BOT_WORKFLOWS`          | off            | Applies migrations 0024, 0025 (if absent), 0031 to 0034, registers bot routes, the `bot_step` job handler, the trigger loop and the signed event endpoint.                                                      |
| `AW_BOT_MCP_AGENTS`         | empty registry | Path to the approved MCP agent registry (JSON, see [mcp-task-contract.md](mcp-task-contract.md)). Invalid content stops startup naming fields only. A missing file means no agent is approved.                  |
| `AW_BOT_MCP_ALLOW_LOOPBACK` | off            | Allows `http://127.0.0.1` / `localhost` agent endpoints. Honoured only with `AW_IDENTITY=local-test` and `NODE_ENV` not `production`. Production requires https plus the registry host allowlist; no redirects. |
| `AW_BOT_ACTIVATE_CURATED`   | none           | Comma-separated curated package ids to activate (for example `brief-writer`). Loading never implies activation.                                                                                                 |
| `AW_BOT_EVENT_KEYS`         | none           | Path to a JSON array `[{ id, source, algorithm: "HS256", secretBase64 }]` or `{ id, source, algorithm: "RS256" or "EdDSA", publicKeyPem }`. One active key per source. Unset: every event is refused (401).     |
| `AW_BOT_TRIGGER_TICK_MS`    | 60000          | Interval of the non-overlapping schedule evaluation loop.                                                                                                                                                       |

Secrets: the registry holds endpoints and allowlists only. HMAC secrets live in the `AW_BOT_EVENT_KEYS` file, which must come from the segment's secret mount (the same mechanism as `keyDir`), never from Markdown, images or logs. Agent credentials are not supported in v1: an agent that needs one is out of scope until a credential-reference design is approved.

## Migrations, rollback and forward repair

| Number | Purpose                                                                                                                     | Reversible by code rollback?                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0031   | `tw_bots`, immutable `tw_bot_revisions`, `tw_bot_runs`, `tw_bot_steps`; widens `wb_tasks`, `tw_jobs`, `wb_approvals` checks | Yes for code. Widened checks stay; older code ignores `kind = 'bot'` rows. |
| 0032   | `tw_skill_packages`, `tw_skill_package_skills`                                                                              | Yes (unused by older code).                                                |
| 0033   | Execution columns, `tw_bots.owner_email`, step cost history                                                                 | Yes (additive columns).                                                    |
| 0034   | `tw_bot_trigger_cursors`                                                                                                    | Yes (unused by older code).                                                |

All four are additive and idempotent and are applied under advisory lock 7017 only when the flag is on. Take a database backup before the first enablement. Rollback = set `AW_BOT_WORKFLOWS` off (or deploy older code) and restart; data stays. Irreversible effects are external: an MCP task that was submitted cannot be unsubmitted by a rollback. Before disabling, list runs in `waiting_external` and cancel them (remote cancel is recorded as `confirmed`, `unsupported` or `uncertain`). Forward repair for a bad revision: publish a corrected revision (runs already started stay pinned to theirs) or revoke the standing grant. Never delete revision or grant rows; both are guarded by triggers.

## Runbook

See [execution.md](execution.md#local-configuration-and-operator-recovery) for `outcome_uncertain`, expired or revoked grants, worker loss, stuck approvals and the global stop (`AW_BOT_WORKFLOWS` off + restart). Additional rules:

- Unknown external effect: inspect the agent's own record for the idempotency key `bot:<taskId>:<stepId>:<attempt>`, then use the step's resolve action with a note. Never retry an uncertain submit.
- Membership revoked: remove the member from the segment's member list (the `AW_M1_<SEGMENT>_MEMBERS` secret for Google identity, `AW_LOCAL_TEST_MEMBERS` for local-test) and restart; the next continuation of every run they own is denied `membership_revoked`.
- Event key rotation: v1 accepts one key per source; rotate by replacing the file entry and restarting, during a quiet window.

## Gate O checklist

Status of every row: **NOT_RUN / AWAITING_OPERATOR**. Owners are assigned by the user. Each row needs explicit user approval before it is run; approval to run is not a pass.

| ID  | Demonstration                                     | Missing prerequisite                                                    | Bounded procedure                                                                                                                                                           | Expected outcome                                                                                 |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| O01 | Conversational design with the live model         | Vertex access and a spend cap for the segment campaign                  | On a dev segment with `LLM_MODE=vertex`, `AW_BOT_WORKFLOWS=on`: run one design request, one malformed request, publish. Cap with the existing model-call limit (≤ 5 calls). | Valid preview, malformed proposal refused, ledger shows ≤ 5 calls                                |
| O02 | Real external MCP agent completes a task          | An approved https agent that implements, or is adapted to, `aw.task.v1` | Add it to `AW_BOT_MCP_AGENTS`; run one bot with a single `mcp_delegate` step; then cancel a second run mid-task.                                                            | Task handle, status transitions, validated result, cost `reported` or `unknown`; cancel recorded |
| O03 | Real connector read and governed action           | Test account and connector authorization (Drive or GitHub)              | Bot with `drive.read` (or `github.read`) step; run as owner; repeat after revoking the connection.                                                                          | First run reads scoped data; second denied before the step                                       |
| O04 | Controlled dev deployment and persistence restart | User merge and deploy decision; dev environment, secrets, backup        | Deploy with the flag on in dev only; start a run with a slow agent task; restart the segment service; confirm resume.                                                       | Same run completes, one submit for its idempotency key                                           |
| O05 | Real schedule/event, concurrency, revocation      | Test identities, an authorized event source key                         | One schedule trigger (Asia/Tokyo) and one signed event delivered twice; `maxConcurrentRunsPerBot=1` with two starts; revoke the grant during an approval wait.              | One run per slot and per event, second start deferred/denied, continuation denied                |
| O06 | Cost reconciliation and rollback rehearsal        | Provider usage export; approved dev exercise                            | Compare run cost (estimated / reported / unknown) with provider usage for O01 and O02; then disable the flag, confirm no new bot processing, re-enable.                     | Differences explained; stop and resume procedure works                                           |

## Known follow-ups recorded with this milestone

- minimatch 10.2.5 (GHSA-g3hv-75wg-m249) is a pre-existing, dev-only advisory reached through eslint. Overriding to 11.x clears `pnpm lint:security` but breaks `pnpm lint:eslint` because `eslint-plugin-import-x` (all released versions) needs minimatch 10's `makeRe`. Per the user's decision it is fixed in a separate follow-up (an import-x release that supports minimatch 11, or a reviewed patch). Gate L reports LOCAL_BLOCKED on this one item.
- Model pricing for bot steps is `unknown` because the existing price table is a placeholder; a finite bot budget therefore refuses further paid steps once an unknown cost is recorded.
- `bigquery.query` cannot be used in a bot step yet (validation reports `unsupported_connector`): the step contract has no metrics comparison scope, which the existing BigQuery adapter requires.
- A2A, dynamic planning, bot sharing and agent credentials are explicit extension boundaries, not implemented.

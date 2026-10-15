# Cloud Workflows dev operator runbook

This runbook accompanies bundled issues #101 and #25. Agents may run local build,
lint, unit tests, and mocked Terraform plan tests. **Cloud deployment, IAM changes,
workflow execution, fault injection in a deployed service, and apply are operator
work.** The optional dev module is disabled by default.

The business task state lives in the Postgres ledger. Cloud Workflows controls
scheduling and callback waits. Cloud execution state must never overwrite ledger
state or serve as proof that an external action succeeded.

## Prerequisites and integration gaps

Before enabling the module, the operator must resolve the #23 gate decisions and
#24 deployment prerequisites and record owner authorization. Use the separate
pilot project in `asia-northeast1`, synthetic Alice/Bob/reviewer identities, and
non-sensitive test data. ADR 0003 permits spend tracking and alerts, not billing
shutdown or spending caps.

This PR supplies an injected adapter and a one-step broker handler. It deliberately
leaves the existing routes, runtime selection, shared ports, local engine, and CI
unchanged. The following integration must exist before cloud acceptance can run:

1. An authenticated Cloud Run broker endpoint calling `advanceCloudWorkflow` with
   a pinned immutable plan selected from the ledger's task/skill version. It accepts
   a task ID only and verifies the dedicated workflow identity. A browser cannot
   supply a plan, subject, endpoint, policy result, or trusted approval payload.
2. A keyless `CloudTransport` using workload identity OAuth for the Workflow
   Executions API. It must redact request bodies, authorization headers, callback
   payloads and remote error details. It must not automatically retry create POSTs.
3. A persistent Postgres checkpoint/signal port and workflow receipt/attempt log.
   Use the existing `createPostgresWorkflowPort` and `createPostgresWorkflowLog`.
   Memory ports and the test mutex are offline test doubles only.
4. A cross-process task lock used by both adapter dispatch and broker ticks, with
   a database/session lifetime that prevents concurrent holders. A mutex in one
   Node process is insufficient. Avoid automatic lease expiry while a holder can
   still issue writes; use fencing plus source idempotency if the lock can expire.
5. A task-service transaction implementing `commit` and `cancelInLedger`: validate
   expected ledger version and domain transition; append a deterministic immutable
   receipt/outbox event; preserve terminal state; repair replay without changing
   receipt identity. Repeated receipts must reconcile to the same external ID.
   The current `LedgerPort` does not expose such an atomic mutation operation.
6. Fresh payload-bound authorization in `authorizeResume`, step `authorize`, and
   **again immediately before the external write in step `execute`**. The broker
   must verify subject/resource ACLs, policy version, approval expiry/digest,
   permitted use count, revocation, and separation of duties. Resume is a hint,
   not a new approval. Approval data stays in the approval service/ledger.
7. External lookup by the stable task/step/payload key. `absent` means an
   authoritative guarantee that the write did not happen; an eventually consistent
   negative lookup is `unknown`. Unknown outcomes wait for operator reconciliation.
   Tools without source idempotency or authoritative lookup are not supported for
   retryable writes. Persist the plan/digest before first dispatch and do not mutate
   it in place: the shared receipt log currently indexes by task and step only.
8. A recovery scanner sourcing tasks from the ledger, invoking
   `recoverCloudWorkflow`, and running broker reconciliation for outstanding
   checkpoint receipts even on cancelled/failed tasks. The current shared ports
   do not expose a task scan. Execution labels help rediscover dispatch after a
   lost create response; they are not a business state store.

These are dependency gaps, not implicit authorization to edit shared contracts.
Track the transaction, scanner, broker/authentication, runtime wiring, and driver
work under the owning integration/contract issues before enabling real writes.
The local engine remains the default until that integration is reviewed.

## Offline checks

Run from repository root with pnpm and Terraform 1.16.5. Do not invoke Trunk for
this task; `pnpm lint` is a Trunk alias, so use the explicit ESLint script.

```sh
pnpm lint:eslint
pnpm build
pnpm test
terraform -chdir=infra/terraform/modules/workflows fmt -check -recursive
terraform -chdir=infra/terraform/modules/workflows init -backend=false
terraform -chdir=infra/terraform/modules/workflows validate
terraform -chdir=infra/terraform/modules/workflows test
terraform -chdir=infra/terraform/environments/dev init -backend=false
terraform -chdir=infra/terraform/environments/dev validate
pnpm exec playwright test --config=e2e/playwright.config.ts --project=dev
```

The last command discovers three operator scenarios and skips them unless opted
in. No skipped scenario is cloud evidence. The module test suite plans both the
module and the dev opt-in using mock Google providers and `command = plan` only.
Registry downloads during init are installation, not cloud access.

## Operator-only source generation and plan/apply

The following sequence is for an authorized human, after the prerequisites above.
It must not be performed by an agent. Obtain keyless operator credentials through
the approved workstation or CI identity; do not create service-account keys or
paste tokens into source, tfvars, command arguments, logs, or test reports.

1. Run `pnpm build`. Import `generateCloudWorkflowDefinition` from
   `apps/api/dist/workflow/cloud-workflows.js` in a local Node script. Supply the
   fixed deployed HTTPS broker URL and its Cloud Run OIDC audience. Write the
   returned JSON to a reviewed local source file. Use the golden fixture only for
   review; its `.example.test` endpoint is not deployable.
2. Prepare protected, untracked operator tfvars with the existing dev project,
   folder, billing account, `enable_workflows = true`, the deployed
   `workflow_broker_service_name`, and `workflow_source_contents` loaded from the
   generated file. These are resource metadata, never credentials. The dev root
   reads identity/dev outputs: aw-api is the adapter and aw-workflow is supplied
   as workflow_service_account_email; aw-tf-dev is the Terraform deployment
   identity. identity/dev owns its per-SA serviceAccountUser attach grant. The
   Workflows module creates no account or deployer attach binding. All three
   emails must be distinct.
3. Use the project's approved state backend and locking setup. `init -backend=false`
   is only for offline checks; review state location and access before a real plan.
4. Review a saved plan. Confirm the enabled resource delta, regional workflow,
   dedicated service account, exact five custom permissions, adapter-only callback
   sender, service-scoped broker invoker, SA-scoped deployer act-as, no keys/public
   members, deletion protection, `LOG_NONE`, and unchanged environment resources.
   Inspect the workflow source for fixed destination/auth and absence of secrets.
5. Review project-scope implications: dispatcher authority covers other workflows
   in the project because Workflows grants IAM at project scope. Isolate the pilot
   project and record that scope explicitly in the approval.
6. The human owner alone approves and applies the saved reviewed plan. Capture the
   non-secret `workflow_adapter` output for runtime configuration. Confirm cloud
   definition compilation and permission support; a mocked plan cannot prove them.
7. Deploy the reviewed broker/runtime integration separately under its owning
   deployment task. Confirm OIDC audience and ingress. Probe an unauthorized
   principal for broker invocation and callback delivery, then probe the explicit
   adapter identity. Do not add a public principal to make an invocation succeed.

For the human operator, the plan/apply command pattern is:

```sh
terraform -chdir=infra/terraform/environments/dev plan -var-file=/protected/operator/workflows.tfvars -out=/protected/operator/workflows.plan
# Human review and recorded approval of that exact saved plan happen here.
terraform -chdir=infra/terraform/environments/dev apply /protected/operator/workflows.plan
```

Never run the apply command as an agent. The saved plan/state can contain source
and resource metadata: store them under the project's restricted evidence policy.
Disabling the opt-in cannot silently remove the workflow: deletion protection must
be explicitly changed and reviewed by an operator before removal. Roll back
runtime selection to local only after preserving ledger/outbox and reconciling all
in-flight external outcomes. Cancellation does not undo a completed external write.

## Operator dev test driver

`e2e/dev/workflow-cloud.spec.ts` is discovered by the existing Playwright harness.
It talks only to a loopback operator driver. The driver is an integration gap;
this PR does not add cloud credentials, runtime selection, routes, or a fault
injection endpoint to the application.

Start the reviewed driver bound to `127.0.0.1`. It owns authentication, synthetic
fixture setup, fault injection, cloud calls, receipt lookup and database reads.
It must refuse scenarios without recorded operator authorization. Then run:

```sh
WORKFLOW_CLOUD_OPERATOR_TESTS=1 WORKFLOW_CLOUD_DRIVER_URL=http://127.0.0.1:9099 pnpm exec playwright test --config=e2e/playwright.config.ts --project=dev
```

The spec POSTs `/scenarios/{scenario}` with synthetic-tenant and reconciliation
requirements. The driver returns a sanitized report with `scenario`,
`operatorAuthorized`, `taskStatus`, `externalWriteCount`,
`duplicateExternalWriteCount`, `receiptCount`, `outboxReceiptCount`,
`ledgerOutboxReconciled`, `authorizationRechecked`, `faultInjected`, and `evidence`
containing `taskId`, `executionNames`, `externalReceiptId`, and `outboxEventIds`.
The spec attaches the report and checks one write, one receipt, one outbox receipt,
zero duplicate writes, and the expected terminal ledger status. Reports must
contain real observations and references to restricted raw evidence, not flags
filled in to satisfy expectations. Never include OAuth tokens, callback payloads,
objective text, raw source content, or approval bodies.

## Fault scenarios

Use one synthetic external write step with a stable canonical payload digest and
source idempotency key. Establish a baseline receipt/outbox query and the external
object count before each scenario. Run each scenario with a new task ID and restore
all injected faults before cleanup.

### `workflow.resume-after-kill`

1. Start the cloud-backed task, stop its broker process after the external write
   succeeds but before receipt/outbox commit, and capture checkpoint and remote
   execution IDs. This is the most consequential kill boundary.
2. Restart the broker against the same Postgres ledger/log and unchanged plan.
   Run the ledger recovery scan. A lost create response must be handled by listing
   the labeled active execution, not blindly resending create.
3. Confirm source lookup recovers the same external receipt without another write.
   Reconcile ledger receipt, workflow log, and outbox; assert `COMPLETED` and one
   external object. Repeat at the checkpoint-before-dispatch boundary and the
   outbox-before-workflow-log boundary as separate recorded probes.

### `workflow.duplicate-signal`

1. Put the task in approval wait with the reviewed exact payload. Send the same
   authorized resume signal ID twice and verify one durable signal row.
2. Kill the dispatcher after signal persistence but before callback POST; deliver
   the same signal again after restart. A duplicate still repairs dispatch.
3. Confirm each delivery and each execution rechecks current authorization. Revoke
   or expire approval before a later duplicate and observe denial without a write.
4. Restore an approved synthetic task, let the callback or timed ledger recheck
   resume it, and reconcile one external object/receipt/outbox event to `COMPLETED`.

### `workflow.cancel-mid-write`

1. Block the external response after the synthetic source accepted the write.
   Commit task cancellation and its outbox event through the task service.
2. Cancel all active cloud executions for that task. Release the response or kill
   and restart the broker, then reconcile the outstanding checkpoint from source.
3. Preserve `CANCELLED`; retain the completed external receipt and its outbox
   evidence. Confirm no subsequent step or duplicate write executes. The completed
   write may require an operator-approved compensating action; do not silently
   delete the receipt or report that cancellation undid it.
4. Also probe cancellation before the write is accepted, expecting zero writes.
   The automated primary mid-write report covers the accepted-write case (one
   receipt); keep the zero-write probe as a separate evidence record.

## Per-step p95 overhead measurement

The 1.5-second p95 overhead target is provisional, not a result of this PR.
Mocked tests and local elapsed times do not measure Cloud Workflows overhead.

1. Pin commit, definition digest, broker revision, plan digest, project/region,
   concurrency, Cloud Workflows quotas, transport settings, wait interval and
   clock synchronization. Record sample counts, load, retries and cold starts.
2. Use a synthetic no-op step and a separately measured broker-only baseline.
   Collect at least 200 normal step transitions after warm-up at representative
   pilot concurrency, then record cold-start and retry cohorts separately.
3. Correlate task/step IDs with Workflows step timestamps and broker spans. Measure
   cloud handoff time from the prior broker response to the next broker request,
   and return/control time where available. Subtract measured broker/tool service
   time from orchestration wall time only using aligned intervals. Do not count
   intentional approval/input waits or operator kill downtime as normal overhead.
4. Export a sanitized CSV with task ID, step ID, cohort, start/end timestamps,
   broker duration, tool duration, wait duration, retry count, and overhead in ms.
   Validate nonnegative durations and account for missing spans. Do not replace
   missing samples with zeros or exclude errors without reporting their rate.
5. For each cohort, sort overhead values ascending and select the nearest-rank
   element at `ceil(0.95 * N)`. Report N, p50, p95, p99, failure/missing rates and
   the provisional 1500 ms comparison. Report callback wake latency separately;
   timed rechecks can add up to the configured wait interval.
6. Attach the measurement method, sanitized samples and restricted raw evidence
   references to the operator review. Decide pass/defer with the owner; do not
   claim the target was met from a test skip or a successful Terraform plan.

# Record an unmet global agent stop

No command in this repo carries out the global agent stop in [RFC-001: Internal Enterprise Agent Platform][rfc-001] section 19.1. Stop searching the repo for a combined switch. Write the incident note in a record other than `docs/runbooks/global-agent-stop.md`. Fill that note from the first section through the last. Skip a section only when that section says to skip it.

These rules cover the whole note.

- Leave `caller` as `[global-stop caller: unnamed]` until a command carries out the four intents. Do not write the production service owner, Yu, Alice, Bob, or the reviewer group in that field. [3. Pilot decisions][adr-0003] records that Yu owns the pilot through C-05, that named owners are required before C-06, and that no human user is bound in infrastructure until those owners exist. Alice, Bob, and the reviewer group are tenant data. RFC-001 section 5.5 is illustrative.
- Mark all four intents unmet. The audit section may add one sentence on the fourth line. That sentence does not mark the line done.
- Leave D-11 and D-12 open. Do not decide them on this page.
- The operational incidents row in RFC-001 section 19.2 does not grant this stop. The handoff names the accountable role and the responsible roles. Those names do not fill `caller`.
- The only call on this page is owner cancel of one task. There is no operator role on that route.
- Do not change shared work or GCP work under a global-stop authority.
- Do not roll a deploy back. No rollback command exists.
- Leave the incident open. Do not collect go-live approval on this page.

## Name the caller before you change anything

Write this token in `caller`.

`[global-stop caller: unnamed]`

The note rules above are why the token stays. The task owner cancel in a later section does not fill this token.

## Write the four intents into the incident note

Write these four lines under `intents`:

- Suspend model and tool invocations.
- Disable ingress to the affected agent. Where a service name would go, write `[services: unnamed, issue 23]`.
- Prevent new workflows.
- Preserve audit records.

Mark each line unmet. Do not mark a line done because a nearby command shares a verb with it.

## Refuse lookalike controls

Write the name of any control you almost ran under `refused`. Write `none` when you did not reach for one. Do not run a control in this section.

- `LocalEngine.halt` is in-process only. It is not an HTTP route. The checkpoint stays resumable. Do not use it as the emergency stop.
- `pnpm dev:down` stops the local Docker stack from `scripts/dev-stack.mjs` and does not touch GCP. `pnpm dev:reset` runs a build, deletes that stack's volumes, and starts the stack again. `compose.dev.yml` does not set `AW_TASKS_CANCEL`. Where a dev host would be named, write `[dev URL: unnamed, issue 24]`.
- `aw policy explain` does not stop work.
- `GET /healthz` returns ok. The response is liveness only.
- `DELETE /v1/oauth/connections/{provider}` returns 501 unless the app was built with an OAuth flow and `AW_OAUTH_REVOKE` is `real`. If you need to rotate or revoke provider access, stop. The route revokes one caller's connection only when the route is real. That call does not list affected tasks, rotate a secret, or notify an admin. RFC-001 section 10.2 denies secret rotation in the MVP under the `ADMIN` class.
- `deliverIncident` in `agents/skills/incident-analysis/deliver.ts` returns kind `written` when that delivery id is already ledgered. Otherwise `deliverIncident` returns kind `revoked` when the skill manifest state is `REVOKED`. Neither of those kinds stops other work.
- `runnerStop` and `POST /v1/ask` with `maxSteps` 4 bind one ask.
- `google_billing_budget.spend` alerts at 0.5, 0.9, 1.0, and 1.5 of 100 USD. `infra/terraform/environments/dev/main.tf` sets those thresholds. `infra/terraform/modules/budget` turns that list into alert rules. The budget has no Pub/Sub topic and does not disable billing. [3. Pilot decisions][adr-0003] says a budget may alert. Do not disable billing. Do not set a hard stop. RFC-001 section 17.2 hard stops do not apply to the dev project.
- `scripts/check-pending.mjs` checks owners in `docs/security/controls.yaml`. The script does not stop work.
- RFC-001 section 15.3 requires a kill switch at global, team, user, agent, skill, model, and tool levels. That switch is not implemented. Do not pick a level and invent one.
- Do not run `terraform apply`, a rollback job, or a `gcloud` invocation to stop work. No rollback job exists in this repo; `.github/workflows/deploy-dev.yml` only deploys, and it is a manual operator action. RFC-001 section 14.4 names rollback as the last pipeline stage. Infra CI in `.github/workflows/infra.yml` runs fmt, `init -backend=false`, validate, tflint, checkov, `terraform test`, `node --test infra/terraform/evidence.test.mjs`, and `node infra/terraform/evidence.mjs`.

If a gateway or policy decision fails, do not fall back to direct network access. S-05 in RFC-001 section 13.3 states that limit. Do not report that offboarding and revocation have blocked all new restricted operations. S-07 says those operations are blocked only eventually. The propagation service level objective is not set. Section 15.2 says to set that objective after the proof of concept.

## Cancel one task you own

Cancel one task you own. Record that this call did not halt queued or retrying workflows you do not own, and that no command in the repo does that.

If you do not have one `taskId`, or you are not that task's `created_by_sub`, write `skipped` under `ownedTaskCancel`. Then go to the next section.

If you are that owner, call `POST /v1/tasks/{taskId}:cancel`. The route is defined in `apps/api/src/routes/tasks-cancel.ts`. Send the header `x-goog-iap-jwt-assertion` and the header `Idempotency-Key`. If you repeat the call for that task, send the same `Idempotency-Key`. Do not send a second key.

The slot in `apps/api/src/routes/slot.ts` keeps the stub unless `AW_TASKS_CANCEL` is `real`. If `AW_TASKS_CANCEL` is not `real`, the stub in `apps/api/src/routes/not-implemented.ts` returns 501 `{ error: 'not_implemented' }`. Record that status and go to the next section.

If the route is real and any of `IAP_JWKS_URL`, `IAP_ISSUER`, and `IAP_AUDIENCE` is missing or empty, the route returns 503 `{ error: 'unavailable' }`. A JWKS fetch failure returns that same 503 after those variables are set. Record the status you got. Do not change an environment variable, a flag, or a deployment from this page. Then go to the next section.

A missing or empty `Idempotency-Key` returns 400 `{ error: 'invalid_request' }`. A failed IAP assertion returns 401 `{ error: 'unauthenticated' }`. An unknown task returns 404 `{ error: 'not_found' }`. A task this caller does not own returns the same 404, because the owner check is `created_by_sub`. If you get 400, 401, or 404, record that status and stop calling. Do not mint a token. Do not scan other tasks. Do not invent a key format.

If you get 200, the body is `{ taskId, status }`. Record the task id and the status string the body returned. Record that the call did not scan other tasks and that completed external side effects remain. RFC-001 section 7 says cancellation cannot undo a completed external side effect. Compensating actions are the follow-up. No compensation command exists. Do not invent one. Leave the workflow receipt in place. If the status string is `CANCELLED`, the route appended `workflow.cancelled` with a null `receipt` when the checkpoint first became `CANCELLED`. If the status string is `COMPLETED` or `FAILED`, the checkpoint was already terminal and the route did not append that event. Do not record an event the status string does not imply. Because issue 24 has not named a dev URL, do not name a host in this call.

## Leave existing audit records alone

Add one sentence on the fourth intent line. Write that existing records stay where they are and that no export was run.

Then fill `receipts`. Because you cannot verify that no new side effect started, record that this check was not run.

Do not replay a write. RFC-001 section 12.2 says to persist the intent, then reconcile the provider receipt. This page has no command that reconciles a provider receipt. If the cancel status string is `CANCELLED`, do not send another write to fill that null `receipt`. The application audit exporter is in memory. Do not treat a running process as an export you can flush from this page. GCP Cloud Audit Logs on this dev project are `ADMIN_READ`, `DATA_READ`, and `DATA_WRITE` for all services. Leave those logs out of `receipts`. Do not invent a log-search URL. The usage line for `scripts/reconcile-audit.mjs` is `reconcile-audit.mjs <spans.jsonl>`. A success line can be `trace propagated`. No CI job calls that script. Do not run the script to close the fourth intent.

## Hand the gap to the incident roles

Write the handoff under `handoff`. Send the note. Name the production service owner as accountable for operational incidents. Name SRE and security incident response as responsible. Record that the RFC status is PROPOSED. Report these section 21 lines as unchecked.

- FinOps caps, alerts, per-task budgets and kill switches exercised.
- Audit event completeness and immutable export reconciled with external system writes.
- DR restore, incident runbooks, rollback and offboarding drills completed.
- Legal, security, IAM, product and SRE go-live approval recorded.

[rfc-001]: ../rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md
[adr-0003]: ../adr/0003-pilot-decisions.md

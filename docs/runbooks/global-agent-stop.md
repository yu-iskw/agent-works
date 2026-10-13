# Record an unmet global agent stop

No command in this repo carries out the global agent stop in [RFC-001: Internal Enterprise Agent Platform][rfc-001] section 19.1. Stop searching the repo for a combined switch. Write the incident note in a record other than `docs/runbooks/global-agent-stop.md`. Fill that note from the first section through the last. Skip a section only when that section says to skip it.

## Name the caller before you change anything

Write this token in `caller`.

`[global-stop caller: unnamed]`

Do not replace that token with the production service owner, Yu, Alice, Bob, or the reviewer group. Yu owns the pilot through C-05. [3. Pilot decisions][adr-0003] records that ownership. Named owners are required before C-06. No human user is bound in infrastructure until those owners exist. Alice, Bob, and the reviewer group are tenant data. RFC-001 section 5.5 is illustrative. Do not name an illustrative role as the caller. The operational incidents row in RFC-001 section 19.2 does not grant this stop. D-11 and D-12 are open. Do not decide D-11 or D-12. If you were about to change shared work or GCP work under a global-stop authority, stop changing it. The task owner cancel in a later section is a separate gate. That cancel does not fill this token.

## Write the four intents into the incident note

Write these four lines under `intents`:

- Suspend model and tool invocations.
- Disable ingress to the affected agent. Where a service name would go, write `[services: unnamed, issue 23]`.
- Prevent new workflows.
- Preserve audit records.

Mark each line unmet. Do not mark a line done because a nearby command shares a verb with it. Later sections may update only the fourth line.

## Refuse lookalike controls

Write the name of any control you almost ran under `refused`. Write `none` when you did not reach for one. Do not run any of these controls as the stop:

- `LocalEngine.halt` is in-process only. It is not an HTTP route. The checkpoint stays resumable. Do not use it as the emergency stop.
- `pnpm dev:down` runs `docker compose -f compose.dev.yml down --remove-orphans`. `pnpm dev:reset` runs `pnpm build`, then `docker compose -f compose.dev.yml down -v --remove-orphans`, then `docker compose -f compose.dev.yml up -d --wait --wait-timeout 100`. Reset starts the stack again. Neither command is the global stop. Neither command touches GCP. Both commands are defined in `package.json` and `scripts/dev-stack.mjs`. `compose.dev.yml` does not set `AW_TASKS_CANCEL`. Where a dev host would be named, write `[dev URL: unnamed, issue 24]`.
- `aw policy explain` does not stop work.
- `GET /healthz` returns ok. The response is liveness only.
- `DELETE /v1/oauth/connections/{provider}` returns 501 unless the app was built with an OAuth flow and `AW_OAUTH_REVOKE` is `real`. If you need to rotate or revoke provider access, stop. The route revokes one caller's connection only when the route is real. That call does not list affected tasks, rotate a secret, or notify an admin. RFC-001 section 10.2 denies secret rotation in the MVP under the `ADMIN` class.
- `deliverIncident` in `agents/skills/incident-analysis/deliver.ts` returns kind `written` when that delivery id is already ledgered. Otherwise `deliverIncident` returns kind `revoked` when the skill manifest state is `REVOKED`. Neither of those kinds stops other work.
- `runnerStop` and `POST /v1/ask` with `maxSteps` 4 bind one ask.
- `google_billing_budget.spend` alerts at 0.5, 0.9, 1.0, and 1.5 of 100 USD. `infra/terraform/environments/dev/main.tf` sets those thresholds. `infra/terraform/modules/environment/budget.tf` turns that list into alert rules. The budget has no Pub/Sub topic and does not disable billing. [3. Pilot decisions][adr-0003] says a budget may alert. Do not disable billing. Do not set a hard stop. RFC-001 section 17.2 hard stops do not apply to the dev project.
- `scripts/check-pending.mjs` checks owners in `docs/security/controls.yaml`. The script does not stop work.
- RFC-001 section 15.3 requires a kill switch at global, team, user, agent, skill, model, and tool levels. That switch is not implemented. Do not pick a level and invent one.
- Do not run `terraform apply`, a rollback job, or a `gcloud` invocation. Those commands are not in this repo. RFC-001 section 14.4 names rollback as the last pipeline stage. Infra CI in `.github/workflows/infra.yml` runs fmt, `init -backend=false`, validate, tflint, checkov, and `terraform test`. The same workflow runs `node --test infra/terraform/evidence.test.mjs` and `node infra/terraform/evidence.mjs`. That workflow has no `terraform apply` and no rollback job.

If a gateway or policy decision fails, do not fall back to direct network access. S-05 in RFC-001 section 13.3 states that limit. Do not report that offboarding and revocation have blocked all new restricted operations. S-07 says those operations are blocked only eventually. The propagation service level objective is not set. Section 15.2 says to set that objective after the proof of concept.

## Cancel one task you own

This section is the only mutation. Cancel one task you own. Record that this call did not halt queued or retrying workflows you do not own, and that no command in the repo does that.

If you do not have one `taskId`, or you are not that task's `created_by_sub`, write `skipped` under `ownedTaskCancel`. Then go to the next section.

If you are that owner, call `POST /v1/tasks/{taskId}:cancel`. The route is defined in `apps/api/src/routes/tasks-cancel.ts`. Send the header `x-goog-iap-jwt-assertion` and the header `Idempotency-Key`. If you repeat the call for that task, send the same `Idempotency-Key`. Do not send a second key.

The slot in `apps/api/src/routes/slot.ts` keeps the stub unless `AW_TASKS_CANCEL` is `real`. If `AW_TASKS_CANCEL` is not `real`, the stub in `apps/api/src/routes/not-implemented.ts` returns 501 `{ error: 'not_implemented' }`. Record that status and go to the next section.

If the route is real and any of `IAP_JWKS_URL`, `IAP_ISSUER`, and `IAP_AUDIENCE` is missing or empty, the route returns 503 `{ error: 'unavailable' }`. Record that status. Do not change an environment variable, a flag, or a deployment from this page. Then go to the next section.

A missing or empty `Idempotency-Key` returns 400 `{ error: 'invalid_request' }`. A failed IAP assertion returns 401 `{ error: 'unauthenticated' }`. An unknown task returns 404 `{ error: 'not_found' }`. A task this caller does not own returns the same 404. The owner check is `created_by_sub`. There is no operator role. If you get 400, 401, or 404, record that status and stop calling. Do not mint a token. Do not scan other tasks. Do not invent a key format.

If you get 200, the body is `{ taskId, status }`. Record the task id and the status string the body returned. Record that the call did not scan other tasks and that completed external side effects remain. RFC-001 section 7 says cancellation cannot undo a completed external side effect. Compensating actions are the follow-up. No compensation command exists. Do not invent one. Leave the workflow receipt in place. Leave the cancel audit event `workflow.cancelled` with a null `receipt`. Because issue 24 has not named a dev URL, do not name a host in this call.

## Leave existing audit records alone

Update only the fourth intent line. Write that the intent stays unmet, that existing records stay where they are, and that no export was run.

Then fill `receipts`. Because you cannot verify that no new side effect started, record that this check was not run.

Do not replay a write. RFC-001 section 12.2 says to persist the intent, then reconcile the provider receipt. This page has no command that reconciles a provider receipt. If cancel returned 200, leave `workflow.cancelled` with a null `receipt`. Do not send another write to fill that null. The application audit exporter is in memory. Do not treat a running process as an export you can flush from this page. GCP Cloud Audit Logs are project admin and data access logs. Leave Cloud Audit Logs out of `receipts`. Do not invent a log-search URL. The usage line for `scripts/reconcile-audit.mjs` is `reconcile-audit.mjs <spans.jsonl>`. A success line can be `trace propagated`. No CI job calls that script. Do not run the script to close the fourth intent.

## Hand the gap to the incident roles

Write the handoff under `handoff`. Send the note. Name the production service owner as accountable for operational incidents. Name SRE and security incident response as responsible. State that the operational incidents row in RFC-001 section 19.2 does not grant this stop. Record that the RFC status is PROPOSED. Do not roll a deploy back. No rollback command exists. Report these section 21 lines as unchecked. The lines are kill switches, audit export, DR restore, rollback, offboarding drills, and legal, security, IAM, product, and SRE go-live approval. State that D-11 and D-12 are open. Do not decide D-11 or D-12. Leave the incident open. Do not collect the go-live approval on this page. Do not mark the four intents done.

[rfc-001]: ../rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md
[adr-0003]: ../adr/0003-pilot-decisions.md

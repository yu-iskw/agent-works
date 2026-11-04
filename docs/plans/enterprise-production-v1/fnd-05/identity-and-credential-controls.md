# FND-05 deployment identity and credential controls

Status: local draft. Nothing is applied. Live proof is AWAITING_OPERATOR.

## Inventory (existing, reused)

- `infra/terraform/identity/dev`: service accounts `aw-deployer`, `aw-web`, `aw-api`, `aw-tool-broker`, `aw-workflow`, `aw-scheduler`; GitHub WIF pool and provider pinned to the repository and to the `deploy-dev.yml` / `infra-plan.yml` workflow refs; deployer impersonated through `principalSet .../attribute.access/dev`. No key resources.
- `modules/cloud_run_service`: `ingress`, `iap_enabled`, digest-pinned images, `secret_env` as Secret Manager refs with pinned numeric versions, `invoker_members` restricted to service accounts.
- `modules/secrets`: containers and per-secret accessor bindings, no values. `modules/artifact_registry`: immutable repo, repository-scoped reader/writer. `modules/network`: custom VPC, no ingress allow rules, Direct VPC egress.
- Web is IAP (`iap_enabled = true`, ingress all). API and tool broker are `INTERNAL_ONLY`, `iap_enabled = false`, SA invokers only.

## Added

- `identity/dev` (`enable_worker`, default false): the `aw-worker` service account itself, because identity resources never live in modules.
- `modules/worker_identity`: bindings for that account (it takes `worker_service_account_email`): invoker allow-list on the worker service, deployer `run.developer` and `serviceAccountUser`, observability project roles (no admin/primitive roles), private artifact bucket (`public_access_prevention = enforced`, uniform access). Rejects the API identity as a caller, empty or non service account callers, and a worker email equal to the API email. The artifact bucket has versioning on and an optional `kms_key_name` (CMEK), see residual risk R-15.
- `apps/api/src/auth/service-identity.ts`: claim-set verifier for worker calls.
- `scripts/fnd-05/check-identity-controls.mjs`: repository and plan-artifact check.

## IAP versus worker endpoint

|               | Human/API path                                                                                                                         | Worker path                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | `aw-web` (IAP), calls `aw-api`                                                                                                         | `aw-worker`                                                                                                                                  |
| Ingress       | web `ALL` with IAP; API `INTERNAL_ONLY`                                                                                                | `INTERNAL_ONLY`, `iap_enabled = false`                                                                                                       |
| Credential    | IAP assertion (ES256, issuer `https://cloud.google.com/iap`, audience `/projects/N/locations/R/services/S`), verified by `auth/iap.ts` | Google ID token minted by an allow-listed service account, audience = worker URL `https://aw-worker-<projectNumber>.asia-northeast1.run.app` |
| Authorization | `iap.httpsResourceAccessor` on web                                                                                                     | `roles/run.invoker` on the worker service for the callers only, plus the `authorizedEmails` check in `service-identity.ts`                   |

The worker is never fronted by the human IAP path, so an IAP assertion replayed to it fails on issuer and audience. Cloud Run IAM rejects unauthorized tokens before the app; the app re-checks the claim set as defence in depth. Signature verification of the ID token (Google OAuth2 certs, RS256) happens in the wiring before `verifyServiceClaims`; the existing `iap.ts` verifier is ES256-only and is not reused for it.

## Rejection matrix (implemented in `service-identity.test.ts`)

| Case                                                                                     | Result                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| Valid token, authorized caller, exact audience                                           | accepted                                   |
| Issuer IAP or foreign or missing                                                         | Unauthenticated                            |
| Audience of another service, IAP-style audience, list with extra entry, missing          | Unauthenticated                            |
| Expired (beyond 30 s skew), missing `exp`, future `iat`                                  | Unauthenticated (`expired` / `bad_claims`) |
| Empty `sub`, unverified or missing email                                                 | Unauthenticated                            |
| Valid token from `aw-api`, `aw-worker`, other-project SA, case-varied email, human email | AuthorizationDenied                        |
| Empty allow-list, non service-account allow-list entry, non-https audience               | policy construction throws                 |

Live equivalents (direct URL without token, wrong audience, unauthorized SA) are operator evidence item OP-1 below.

## Credential and IAM checks

`node scripts/fnd-05/check-identity-controls.mjs [--plan-dir <dir>]` scans tracked files and each plan directory. It fails on a service-account key JSON field, PEM private key, `service_account` key file type, a `google_service_account_key` resource (HCL or plan JSON), and on a public principal in `.tf`/`.tfvars` or bound to an invoker role in plan JSON. Run it against `terraform show -json` output before any approval. Tested in `check-identity-controls.test.mjs`, including a pass on this repository.

## Secrets

Secrets are Secret Manager references only: `modules/secrets` creates containers, services use `secret_env` with pinned numeric versions (`latest` rejected). Values are added by an operator with `secretVersionAdder` outside Terraform. Worker secret access is added as `accessor_emails = [worker email]` per secret; no project-wide `secretAccessor`.

## Network policy

Worker and API are `INTERNAL_ONLY`; Cloud Scheduler, Workflows and Tasks callers are internal for this ingress. Egress goes through the Direct VPC subnet (`ALL_TRAFFIC`), NAT optional. The VPC has no ingress allow rules.

## Exact roles

| Principal                                           | Roles                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aw-worker`                                         | project: `logging.logWriter`, `monitoring.metricWriter`, `cloudtrace.agent`; bucket: `storage.objectUser`; registry: `artifactregistry.reader`; per secret: `secretmanager.secretAccessor` |
| `aw-api`                                            | existing grants; bucket `storage.objectUser`                                                                                                                                               |
| callers (`aw-scheduler`, `aw-workflow`, dispatcher) | `run.invoker` on the worker service only                                                                                                                                                   |
| `aw-deployer`                                       | `run.developer` on the worker service, `iam.serviceAccountUser` on `aw-worker`, impersonated by WIF only                                                                                   |
| public principals                                   | none                                                                                                                                                                                       |

## Wiring (not applied; coordinator or operator)

Set `enable_worker = true` in `identity/dev` first. In `environments/dev` add a `module "worker_identity"` with `worker_service_account_email = local.sa.worker`, `api_service_account_email = local.sa.api`, `deployer_email = local.sa.deployer`, `caller_service_account_emails` from the dispatcher/scheduler/workflow SAs, a `cloud_run_service` module `aw-worker` with `iap_enabled = false`, `ingress = module.worker_identity.required_ingress`, `service_account_email = module.worker_identity.service_account_email`; add the worker email to `artifact_registry.reader_emails` and the needed `secrets` `accessor_emails`. Then run the checker on `terraform show -json`. Excluded by brief: `.github/workflows/deploy-dev.yml` (#24) and #25 paths.

## Operator steps and evidence (AWAITING_OPERATOR)

1. OP-0 Approve the wiring PR and the apply (operator-approval template).
2. OP-1 SEC-04 live: call the worker URL with no token, a token with the wrong audience, and a token from an unauthorized SA; expect 401/403 each. Record redacted status codes.
3. OP-2 `gcloud run services get-iam-policy aw-worker` shows only the allow-listed callers.
4. OP-3 `gcloud iam service-accounts keys list` for each `aw-*` account shows only system-managed keys.
5. OP-4 Plan JSON passes the checker.

## Rollback

Module and files are additive and unwired; delete `modules/worker_identity` to revert. After apply, remove the module block to delete bindings; the bucket has `force_destroy = false` so non-empty buckets block deletion.

## Open decisions

Artifact retention, bucket access logging and versioning (checkov skips noted in the module). Where the dispatcher identity lives (FND/AGT owners).

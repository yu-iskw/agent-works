# Optional pilot Cloud Workflows

This module implements #101, the infrastructure prerequisite for #25. It creates a
regional workflow using an existing dedicated execution service-account email.
The identity root creates that account in the existing pilot project. It enables the Workflows and Workflow Executions APIs. Nothing executes a
workflow as part of Terraform provisioning.

The dev invocation in `environments/dev/workflows.tf` has `enable_workflows = false`
by default. The default plan contains no resources from this module. Turning it on
requires a reviewed definition and an existing authenticated broker service.

## Inputs

| Variable                         | Required / default    | Meaning                                                   |
| -------------------------------- | --------------------- | --------------------------------------------------------- |
| `project_id`                     | Required              | Existing isolated pilot project                           |
| `region`                         | `asia-northeast1`     | Accepted ADR 0003 region; other regions rejected          |
| `name`                           | `pilot-durable-tasks` | Workflow name and custom-role namespace                   |
| `workflow_service_account_email` | Required              | Existing dedicated aw-workflow execution identity         |
| `adapter_service_account_email`  | Required              | Existing keyless task-service dispatcher                  |
| `deployer_service_account_email` | Required              | Existing operator-approved deployer                       |
| `broker_service_name`            | Required              | Existing Cloud Run v2 service in this project/region      |
| `source_contents`                | Required              | Reviewed JSON/YAML from `generateCloudWorkflowDefinition` |

The execution, dispatcher, and deployer identities must be distinct. IAM accepts
explicit service-account emails only. The module does not create users, keys,
OAuth credentials, a Cloud Run service, a database, or a broker endpoint.

## IAM boundary

| Principal                              | Grant                          | Scope                                   |
| -------------------------------------- | ------------------------------ | --------------------------------------- |
| Dedicated workflow execution identity  | `roles/run.invoker`            | Named broker Cloud Run service only     |
| Existing task-service adapter identity | Custom dispatcher role         | Pilot project                           |
| aw-tf-dev (identity root binding)      | `roles/iam.serviceAccountUser` | Dedicated workflow service account only |

The custom role contains exactly the five permissions used by the adapter:

- `workflows.executions.create`
- `workflows.executions.list`
- `workflows.executions.cancel`
- `workflows.callbacks.list`
- `workflows.callbacks.send`

Workflows exposes these grants at project scope, according to its
[access-control documentation](https://docs.cloud.google.com/workflows/docs/access-control).
The dispatcher can control other workflows in that project. Use a separate pilot
project; do not describe this as workflow-resource isolation. Adding workflows to
that project changes the effective permission boundary and requires operator review.
The custom role omits workflow deployment, deletion, IAM administration, and token
creation permissions. This module does not grant workflow deployment privileges;
the existing operator deployment identity must already have reviewed authority.

Callbacks use Google's authenticated Workflow Executions endpoint. There is no
public invoker grant or separately deployed callback server. Only the explicit
adapter principal receives callback-send permission. A callback is a wake-up hint,
never evidence that an approval or authorization is valid. The broker checks the
ledger and fresh policy on every tick.

The workflow calls the fixed broker endpoint with OIDC as its dedicated service
account. Broker ingress and application authorization are owned by the broker
service. The module grants service invocation but cannot validate that service's
application logic. Bootstrap retains the prohibition on service-account key
creation/upload; this module creates no service accounts or keys. The attach
binding belongs to identity/dev; aw-tf-dev is passed as the deployment identity.

## Outputs

`adapter` supplies `project_id`, `region`, `workflow_name`,
`execution_api_base_url`, `service_account_email`, and `dispatcher_email`.
The TypeScript adapter consumes `workflow_name`; its injected transport uses
keyless OAuth to contact the Workflow Executions API. These outputs are metadata,
not credentials. `permissions` and `iam_bindings` expose the exact permission and
principal sets for review. The dev environment exposes `workflow_adapter`, which
is null while disabled.

## Offline verification

Use Terraform 1.16.5, matching the repository, and the pinned Google provider 8.5.0.
Provider installation may require registry access once. Mock tests need no Google
credentials and make no GCP calls after that installation.

```sh
terraform -chdir=infra/terraform/modules/workflows fmt -check -recursive
terraform -chdir=infra/terraform/modules/workflows init -backend=false
terraform -chdir=infra/terraform/modules/workflows validate
terraform -chdir=infra/terraform/modules/workflows test
```

Every test run uses `command = plan` with a mocked provider. Tests assert exact
permissions and service-account bindings, reject public/human/shared identities,
check deletion protection and call-log settings. The dev root suite plans opt-in
both disabled and enabled. Plan-time mock overrides make computed identity
values assertable without an apply.

Terraform validates resource schemas and references; it does not compile the
Workflows language. The API tests compare the generated source against a reviewed
golden definition. An operator must still verify cloud compilation, callback IAM,
OIDC audience, ingress, quota, and custom-role permission availability in the
actual pilot project before treating deployment as accepted.

The module disables call payload logging and enables workflow deletion protection.
The supplied definition must contain endpoint metadata only. Terraform state will
store it; credentials and sensitive task data must never be embedded in source.

See [the operator runbook](../../../../docs/runbooks/cloud-workflows-dev.md) for
integration prerequisites, plan/apply review, fault tests, and p95 measurement.

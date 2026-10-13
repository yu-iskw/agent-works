mock_provider "google" {
  mock_resource "google_service_account" {
    override_during = plan
    defaults = {
      email  = "pilot-workflow@pilot-dev-check.iam.gserviceaccount.com"
      member = "serviceAccount:pilot-workflow@pilot-dev-check.iam.gserviceaccount.com"
      name   = "projects/pilot-dev-check/serviceAccounts/pilot-workflow@pilot-dev-check.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_project_iam_custom_role" {
    override_during = plan
    defaults        = { name = "projects/pilot-dev-check/roles/pilot_durable_tasks_adapter" }
  }
}
variables {
  project_id                     = "pilot-dev-check"
  adapter_service_account_email  = "pilot-task-service@pilot-dev-check.iam.gserviceaccount.com"
  deployer_service_account_email = "pilot-deployer@pilot-dev-check.iam.gserviceaccount.com"
  broker_service_name            = "pilot-task-broker"
  source_contents                = "main:\n  steps:\n    - done:\n        return: null\n"
}
run "dedicated_identity" {
  command = plan
  assert {
    condition     = google_service_account.workflow.account_id == "pilot-workflow"
    error_message = "Workflow execution must have its own named identity."
  }
  assert {
    condition     = google_workflows_workflow.tasks.service_account == google_service_account.workflow.email
    error_message = "Workflow must execute as the dedicated service account."
  }
  assert {
    condition     = google_service_account.workflow.email != var.adapter_service_account_email && google_service_account.workflow.email != var.deployer_service_account_email
    error_message = "Dispatcher, deployment and execution identities must be separate."
  }
}
run "exact_dispatcher_permissions" {
  command = plan
  assert {
    condition = toset(google_project_iam_custom_role.adapter.permissions) == toset([
      "workflows.executions.create", "workflows.executions.list",
      "workflows.executions.cancel", "workflows.callbacks.list", "workflows.callbacks.send",
    ])
    error_message = "Dispatcher must have only execution control and callback delivery permissions."
  }
  assert {
    condition     = google_project_iam_member.adapter.member == "serviceAccount:${var.adapter_service_account_email}"
    error_message = "Only the explicit keyless task-service identity may dispatch or send callbacks."
  }
  assert {
    condition     = google_project_iam_member.adapter.role == google_project_iam_custom_role.adapter.name
    error_message = "Bind the exact custom dispatcher role, not a broad predefined role."
  }
}
run "broker_invoker_is_service_scoped" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_service_iam_member.broker.name == var.broker_service_name && google_cloud_run_v2_service_iam_member.broker.role == "roles/run.invoker"
    error_message = "Execution identity may invoke only the named broker service."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.broker.member == google_service_account.workflow.member
    error_message = "Broker invoker must be the dedicated execution identity."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.broker.project == var.project_id && google_cloud_run_v2_service_iam_member.broker.location == "asia-northeast1"
    error_message = "Broker invocation must stay within the accepted pilot project and region."
  }
}
run "deployer_can_only_attach_identity" {
  command = plan
  assert {
    condition     = google_service_account_iam_member.deployer.service_account_id == google_service_account.workflow.name
    error_message = "Deployer act-as must be scoped to the dedicated workflow identity."
  }
  assert {
    condition     = google_service_account_iam_member.deployer.role == "roles/iam.serviceAccountUser" && google_service_account_iam_member.deployer.member == "serviceAccount:${var.deployer_service_account_email}"
    error_message = "No token creation, keys, or human deployment principal is granted."
  }
}
run "workflow_waits_for_deployer_act_as" {
  command = plan
  # Dependency edges are not resource attributes; inspect the workflow declaration.
  assert {
    condition = length(regexall(
      "(?s)resource \"google_workflows_workflow\" \"tasks\" \\{.*?depends_on\\s*=\\s*\\[[^]]*google_service_account_iam_member\\.deployer",
      file("${path.module}/main.tf"),
    )) == 1
    error_message = "Workflow creation must explicitly depend on the deployer's actAs grant."
  }
}
run "resource_safety" {
  command = plan
  assert {
    condition     = google_workflows_workflow.tasks.region == "asia-northeast1" && google_workflows_workflow.tasks.project == var.project_id
    error_message = "Workflow must use the accepted pilot region and project."
  }
  assert {
    condition     = google_workflows_workflow.tasks.call_log_level == "LOG_NONE" && google_workflows_workflow.tasks.deletion_protection
    error_message = "Disable payload call logging and require explicit deletion review."
  }
  assert {
    condition     = google_workflows_workflow.tasks.source_contents == var.source_contents
    error_message = "Deploy only the operator-supplied reviewed definition."
  }
  assert {
    condition     = toset(keys(google_project_service.workflows)) == toset(["workflows.googleapis.com", "workflowexecutions.googleapis.com"])
    error_message = "Only the two necessary workflow APIs are enabled."
  }
  assert {
    condition     = alltrue([for api in google_project_service.workflows : !api.disable_on_destroy])
    error_message = "Destroying opt-in resources must not disable shared APIs."
  }
}
run "adapter_outputs" {
  command = plan
  assert {
    condition     = output.adapter.workflow_name == "projects/pilot-dev-check/locations/asia-northeast1/workflows/pilot-durable-tasks"
    error_message = "Adapter resource name must follow the REST API format."
  }
  assert {
    condition     = output.adapter.execution_api_base_url == "https://workflowexecutions.googleapis.com/v1/${output.adapter.workflow_name}/executions"
    error_message = "Adapter endpoint must target the planned workflow."
  }
  assert {
    condition     = output.adapter.dispatcher_email == var.adapter_service_account_email && output.adapter.service_account_email == google_service_account.workflow.email
    error_message = "Outputs must identify both separate keyless identities."
  }
}
run "no_public_principals_or_keys" {
  command = plan
  assert {
    condition = alltrue([
      for binding in values(output.iam_bindings) : startswith(binding.member, "serviceAccount:")
    ])
    error_message = "No public or user principal may appear in module IAM bindings."
  }
  assert {
    condition = length(regexall("google_service_account_key|roles/(owner|editor)|allUsers|allAuthenticatedUsers", join("\n", [
      for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")
    ]))) == 0
    error_message = "The module must declare no keys, basic administrator roles or public invocation."
  }
}
run "reject_public_dispatcher" {
  command = plan
  variables { adapter_service_account_email = "allUsers" }
  expect_failures = [var.adapter_service_account_email]
}
run "reject_human_deployer" {
  command = plan
  variables { deployer_service_account_email = "operator@example.test" }
  expect_failures = [var.deployer_service_account_email]
}
run "reject_unaccepted_region" {
  command = plan
  variables { region = "us-central1" }
  expect_failures = [var.region]
}
run "reject_empty_definition" {
  command = plan
  variables { source_contents = " " }
  expect_failures = [var.source_contents]
}
run "reject_url_as_service" {
  command = plan
  variables { broker_service_name = "https://broker.example.test" }
  expect_failures = [var.broker_service_name]
}
run "reject_shared_runtime_identity" {
  command = plan
  variables { adapter_service_account_email = "pilot-workflow@pilot-dev-check.iam.gserviceaccount.com" }
  expect_failures = [var.adapter_service_account_email]
}
run "reject_shared_deployer_identity" {
  command = plan
  variables { deployer_service_account_email = "pilot-workflow@pilot-dev-check.iam.gserviceaccount.com" }
  expect_failures = [var.deployer_service_account_email]
}

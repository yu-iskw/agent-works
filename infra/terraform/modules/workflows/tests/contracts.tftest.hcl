mock_provider "google" {}
variables {
  project_id                     = "aw-test-project"
  workflow_service_account_email = "aw-workflow@aw-test-project.iam.gserviceaccount.com"
  adapter_service_account_email  = "aw-api@aw-test-project.iam.gserviceaccount.com"
  deployer_service_account_email = "aw-tf-dev@aw-test-project.iam.gserviceaccount.com"
  broker_service_name            = "aw-tool-broker"
  source_contents                = "main:\n  steps:\n    - done:\n        return: null\n"
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_workflows_workflow.tasks.service_account == var.workflow_service_account_email && google_workflows_workflow.tasks.call_log_level == "LOG_NONE" && google_workflows_workflow.tasks.deletion_protection
    error_message = "Existing identity, no payload logs, protected workflow."
  }
  assert {
    condition     = toset(output.permissions) == toset(["workflows.executions.create", "workflows.executions.list", "workflows.executions.cancel", "workflows.callbacks.list", "workflows.callbacks.send"])
    error_message = "Exact dispatcher permissions."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.broker.member == "serviceAccount:${var.workflow_service_account_email}" && google_cloud_run_v2_service_iam_member.broker.name == var.broker_service_name
    error_message = "Broker-scoped invocation only."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    workflow_service_account_email = "human@example.test"
  }
  expect_failures = [var.workflow_service_account_email]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}
run "reject_shared_dispatcher" {
  command = plan
  variables {
    adapter_service_account_email = "aw-workflow@aw-test-project.iam.gserviceaccount.com"
  }
  expect_failures = [var.adapter_service_account_email]
}
run "reject_shared_deployer" {
  command = plan
  variables {
    deployer_service_account_email = "aw-workflow@aw-test-project.iam.gserviceaccount.com"
  }
  expect_failures = [var.deployer_service_account_email]
}
run "reject_same_dispatcher_and_deployer" {
  command = plan
  variables {
    adapter_service_account_email = "aw-tf-dev@aw-test-project.iam.gserviceaccount.com"
  }
  expect_failures = [var.adapter_service_account_email]
}
run "source_apis_and_adapter_metadata" {
  command = plan
  assert {
    condition     = google_workflows_workflow.tasks.source_contents == var.source_contents
    error_message = "Deploy only the reviewed source."
  }
  assert {
    condition     = toset(keys(google_project_service.workflows)) == toset(["workflows.googleapis.com", "workflowexecutions.googleapis.com"]) && alltrue([for api in google_project_service.workflows : !api.disable_on_destroy])
    error_message = "Only the two Workflows APIs, kept on destroy."
  }
  assert {
    condition     = output.adapter.workflow_name == "projects/aw-test-project/locations/asia-northeast1/workflows/pilot-durable-tasks" && output.adapter.execution_api_base_url == "https://workflowexecutions.googleapis.com/v1/${output.adapter.workflow_name}/executions" && output.adapter.dispatcher_email == var.adapter_service_account_email
    error_message = "Adapter metadata must match the reviewed resource and distinct dispatcher."
  }
}
run "reject_empty_source" {
  command = plan
  variables { source_contents = " " }
  expect_failures = [var.source_contents]
}
run "reject_broker_url" {
  command = plan
  variables { broker_service_name = "https://broker.example.test" }
  expect_failures = [var.broker_service_name]
}
run "reject_human_deployer" {
  command = plan
  variables { deployer_service_account_email = "human@example.test" }
  expect_failures = [var.deployer_service_account_email]
}
run "reject_public_dispatcher" {
  command = plan
  variables { adapter_service_account_email = "allUsers" }
  expect_failures = [var.adapter_service_account_email]
}

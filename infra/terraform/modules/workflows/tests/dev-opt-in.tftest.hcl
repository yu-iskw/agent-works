mock_provider "google" {}
variables {
  project_id         = "pilot-dev-check"
  folder_id          = "100000000001"
  billing_account_id = "ABCDEF-ABCDEF-ABCDEF"
}
run "dev_disabled_by_default" {
  command = plan
  module { source = "../../environments/dev" }
  assert {
    condition     = length(module.workflows) == 0
    error_message = "Dev must instantiate no workflow resources by default."
  }
  assert {
    condition     = output.workflow_adapter == null
    error_message = "Disabled workflow adapter output must be null."
  }
}
run "dev_explicit_opt_in" {
  command = plan
  module { source = "../../environments/dev" }
  variables {
    enable_workflows             = true
    workflow_broker_service_name = "pilot-task-broker"
    workflow_source_contents     = "main:\n  steps:\n    - done:\n        return: null\n"
  }
  assert {
    condition     = length(module.workflows) == 1
    error_message = "Explicit opt-in must instantiate exactly one workflow module."
  }
  assert {
    condition     = module.workflows[0].adapter.workflow_name == "projects/pilot-dev-check/locations/asia-northeast1/workflows/pilot-durable-tasks"
    error_message = "Dev opt-in must expose the expected regional workflow resource."
  }
}

mock_provider "google" {}
variables {
  project_id                   = "aw-test-project"
  apis                         = ["iam.googleapis.com"]
  guard_constraints            = ["iam.disableServiceAccountKeyCreation", "iam.disableServiceAccountKeyUpload", "iam.automaticIamGrantsForDefaultServiceAccounts"]
  deprivilege_default_accounts = true
}
run "approved_interface" {
  command = plan
  assert {
    condition     = alltrue([for policy in values(output.org_policies) : policy == "TRUE"])
    error_message = "Guards enforced."
  }
  assert {
    condition     = google_project_default_service_accounts.deprivilege[0].action == "DEPRIVILEGE" && output.default_accounts_action == "DEPRIVILEGE"
    error_message = "Default accounts lose broad roles."
  }
  assert {
    condition     = alltrue([for api in google_project_service.api : !api.disable_on_destroy])
    error_message = "Keep shared APIs enabled."
  }
}
run "audit_config_default_on" {
  command = plan
  assert {
    condition     = output.audit_log.service == "allServices" && output.audit_log.log_types == toset(["ADMIN_READ", "DATA_READ", "DATA_WRITE"])
    error_message = "Audit config enabled by default."
  }
}
run "audit_config_can_be_disabled" {
  command = plan
  variables {
    enable_audit_config = false
  }
  assert {
    condition     = output.audit_log == null && length(google_project_iam_audit_config.all_services) == 0
    error_message = "Audit config can be disabled for adopted projects."
  }
}
run "reject_unknown_guard_constraint" {
  command = plan
  variables {
    guard_constraints = ["iam.disableServiceAccountKeyCreationTypo"]
  }
  expect_failures = [var.guard_constraints]
}

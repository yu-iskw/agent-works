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
    condition     = google_project_default_service_accounts.deprivilege[0].action == "DEPRIVILEGE"
    error_message = "Default accounts lose broad roles."
  }
  assert {
    condition     = alltrue([for api in google_project_service.api : !api.disable_on_destroy])
    error_message = "Keep shared APIs enabled."
  }
}

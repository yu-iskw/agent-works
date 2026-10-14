mock_provider "google" {
  mock_resource "google_service_account" {
    override_during = plan
    defaults        = { name = "projects/aw-test-project/serviceAccounts/mock@aw-test-project.iam.gserviceaccount.com" }
  }
}
variables {
  project_id         = "aw-test-project"
  folder_id          = "100000000001"
  billing_account_id = "ABCDEF-ABCDEF-ABCDEF"
  operator_member    = "user:yu@example.test"
  breakglass_member  = "group:aw-breakglass@example.test"
}
run "bootstrap_contract" {
  command = plan
  assert {
    condition     = toset(keys(google_service_account.terraform)) == toset(["aw-tf-identity", "aw-tf-dev", "aw-tf-plan"])
    error_message = "Bootstrap creates exactly three Terraform accounts."
  }
  assert {
    condition     = toset(keys(google_service_account_iam_member.operator)) == toset(["aw-tf-identity", "aw-tf-dev", "aw-tf-plan"]) && alltrue([for binding in google_service_account_iam_member.operator : binding.role == "roles/iam.serviceAccountTokenCreator" && binding.member == var.operator_member])
    error_message = "Operator tokens are per-SA only."
  }
  assert {
    condition     = google_service_account_iam_member.breakglass.role == "roles/iam.serviceAccountTokenCreator" && google_service_account_iam_member.breakglass.member == var.breakglass_member && google_service_account_iam_member.breakglass.service_account_id == google_service_account.terraform["aw-tf-identity"].name
    error_message = "Breakglass may impersonate identity only."
  }
  assert {
    condition     = alltrue([for binding in values(module.terraform_roles.iam_bindings) : binding.role != "roles/iam.serviceAccountTokenCreator"])
    error_message = "No project tokenCreator."
  }
  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access && google_storage_bucket.state.public_access_prevention == "enforced" && google_storage_bucket.state.versioning[0].enabled
    error_message = "State must be private, uniform and versioned."
  }
  assert {
    condition     = google_storage_bucket.state.lifecycle_rule[0].condition[0].num_newer_versions == 30
    error_message = "Keep thirty archived versions."
  }
  assert {
    condition     = alltrue([for policy in values(module.baseline.org_policies) : policy == "TRUE"]) && length(module.baseline.org_policies) == 3
    error_message = "All key and default-SA guards must be enforced."
  }
  assert {
    condition     = module.baseline.audit_log.service == "allServices" && module.baseline.audit_log.log_types == toset(["ADMIN_READ", "DATA_READ", "DATA_WRITE"])
    error_message = "Audit every service."
  }
  assert {
    condition     = google_project.dev.deletion_policy == "PREVENT" && !google_project.dev.auto_create_network
    error_message = "Project must be protected without a default network."
  }
  assert {
    condition     = google_storage_bucket_iam_member.plan.role == "roles/storage.objectViewer" && google_storage_bucket_iam_member.applier["aw-tf-dev"].condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/dev/')"
    error_message = "State writes must be prefix scoped; plan reads only."
  }
}

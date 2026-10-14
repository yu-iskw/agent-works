mock_provider "google" {
  mock_resource "google_iam_workload_identity_pool" {
    override_during = plan
    defaults        = { name = "projects/123456789012/locations/global/workloadIdentityPools/aw-github" }
  }
}
variables {
  project_id                     = "aw-test-project"
  terraform_service_account      = "aw-tf-identity@aw-test-project.iam.gserviceaccount.com"
  terraform_dev_service_account  = "aw-tf-dev@aw-test-project.iam.gserviceaccount.com"
  terraform_plan_service_account = "aw-tf-plan@aw-test-project.iam.gserviceaccount.com"
}
run "exact_identity_and_binding_set" {
  command = plan
  assert {
    condition     = toset([for account in google_service_account.runtime : account.account_id]) == toset(["aw-deployer", "aw-web", "aw-api", "aw-tool-broker", "aw-workflow", "aw-scheduler"])
    error_message = "D2 requires exactly six default responsibilities."
  }
  assert {
    condition     = length(google_service_account.analytics) == 0 && length(google_service_account.agent) == 0
    error_message = "Conditional identities must be absent by default."
  }
  assert {
    condition     = alltrue([for role in output.grantable_roles : !contains(["roles/owner", "roles/editor"], role) && !can(regex("^roles/iam\\..*Admin$", role))])
    error_message = "D6 must forbid basic and IAM admin roles."
  }
  assert {
    condition     = module.dev_iam.iam_bindings["dev/roles/resourcemanager.projectIamAdmin"].condition.expression == "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(sort(tolist(output.grantable_roles)))})"
    error_message = "Guard must use the exact role allowlist."
  }
  assert {
    condition = toset([for binding in values(output.iam_bindings) : "${binding.member}|${binding.role}|${binding.scope}"]) == toset(["serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-deployer@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-web@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-api@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-tool-broker@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-workflow@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-scheduler@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-deployer@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-web@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-deployer@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-api@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/resourcemanager.projectIamAdmin|aw-test-project",
      "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/aw-github/attribute.access/dev|roles/iam.workloadIdentityUser|aw-deployer@aw-test-project.iam.gserviceaccount.com",
    "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/aw-github/attribute.access/plan|roles/iam.workloadIdentityUser|aw-tf-plan@aw-test-project.iam.gserviceaccount.com"])
    error_message = "Every binding must equal the literal snapshot."
  }
}
run "optional_identities" {
  command = plan
  variables {
    enable_bigquery_analytics = true
    enable_agent              = true
  }
  assert {
    condition     = length(google_service_account.analytics) == 1 && length(google_service_account.agent) == 1
    error_message = "Explicit flags create one identity each."
  }
}
run "literal_grant_allowlist" {
  command = plan
  assert {
    condition = output.grantable_roles == toset([
      "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent",
      "roles/aiplatform.user", "roles/cloudsql.client", "roles/cloudsql.instanceUser",
      "roles/bigquery.jobUser", "roles/bigquery.dataViewer", "roles/artifactregistry.writer",
      "roles/run.developer", "roles/run.invoker", "roles/iam.serviceAccountUser",
      "roles/secretmanager.secretAccessor", "roles/cloudkms.cryptoKeyEncrypterDecrypter",
      "roles/workflows.invoker", "projects/aw-test-project/roles/pilot_durable_tasks_adapter",
    ])
    error_message = "D6 roles must match the literal approved runtime/deployer allowlist."
  }
}

mock_provider "google" {
  mock_resource "google_service_account" {
    override_during = plan
    defaults = {
      name  = "projects/aw-test-project/serviceAccounts/aw-tf-mock@aw-test-project.iam.gserviceaccount.com"
      email = "aw-tf-mock@aw-test-project.iam.gserviceaccount.com"
    }
  }
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
    condition = toset([for binding in values(output.iam_bindings) : "${binding.member}|${binding.role}|${binding.scope}"]) == toset(["serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-deployer@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-web@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-api@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-tool-broker@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-workflow@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-scheduler@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-deployer@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-web@aw-test-project.iam.gserviceaccount.com",
      "serviceAccount:aw-deployer@aw-test-project.iam.gserviceaccount.com|roles/iam.serviceAccountUser|aw-api@aw-test-project.iam.gserviceaccount.com",
      "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/aw-github/attribute.access/dev|roles/iam.workloadIdentityUser|aw-deployer@aw-test-project.iam.gserviceaccount.com",
    "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/aw-github/attribute.access/plan|roles/iam.workloadIdentityUser|aw-tf-plan@aw-test-project.iam.gserviceaccount.com"])
    error_message = "Every binding must equal the literal snapshot."
  }
  assert {
    condition     = output.wif_attribute_mapping["attribute.job_workflow_ref"] == "assertion.job_workflow_ref" && output.wif_attribute_mapping["attribute.access"] == "'environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/deploy-dev.yml@refs/heads/main' ? 'dev' : (((assertion.event_name == 'pull_request' && assertion.job_workflow_ref.startsWith('yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/pull/')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/heads/main')) ? 'plan' : 'denied')" && can(regex("deploy-dev\\.yml@refs/heads/main", output.wif_attribute_condition)) && can(regex("infra-plan\\.yml@refs/heads/main", output.wif_attribute_condition))
    error_message = "Identity root must expose WIF mapping and condition with deploy-dev.yml and infra-plan.yml pinned on refs/heads/main."
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
run "no_project_iam_writes" {
  command = plan
  assert {
    condition     = alltrue([for binding in values(output.iam_bindings) : binding.scope != var.project_id]) && length(regexall("modules/project_iam|google_project_iam_member", file("${path.module}/impersonation.tf"))) == 0
    error_message = "Identity applier must never write project IAM."
  }
}

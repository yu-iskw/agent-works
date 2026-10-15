resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "Agent Works GitHub"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:Trust is pinned by assertion.repository in attribute_condition and by per-SA principalSet bindings on attribute.access (plan/dev); a literal assertion.sub check would not cover both workflows.
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.job_workflow_ref" = "assertion.job_workflow_ref"
    "attribute.access"           = "'environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == '${var.repository}/.github/workflows/deploy-dev.yml@refs/heads/main' ? 'dev' : (assertion.job_workflow_ref == '${var.repository}/.github/workflows/infra-plan.yml@refs/heads/main' && (assertion.event_name == 'pull_request' || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main')) ? 'plan' : 'denied')"
  }
  attribute_condition = "assertion.repository == '${var.repository}' && (${var.attribute_condition})"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

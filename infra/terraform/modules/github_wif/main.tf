resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "Agent Works GitHub"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.access"     = "assertion.event_name == 'pull_request' || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main') ? 'plan' : ('environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' ? 'dev' : 'denied')"
  }
  attribute_condition = "assertion.repository == '${var.repository}' && (${var.attribute_condition})"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

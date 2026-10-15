locals {
  # D6: one allowlist; no Owner, Editor or iam.*Admin role may be granted.
  grantable_roles = toset([
    "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent",
    "roles/aiplatform.user", "roles/cloudsql.client", "roles/cloudsql.instanceUser",
    "roles/bigquery.jobUser", "roles/bigquery.dataViewer",
    "roles/artifactregistry.writer", "roles/run.developer", "roles/run.invoker",
    "roles/iam.serviceAccountUser", "roles/secretmanager.secretAccessor",
    "roles/cloudkms.cryptoKeyEncrypterDecrypter", "roles/workflows.invoker",
    "projects/${var.project_id}/roles/pilot_durable_tasks_adapter",
  ])
}
module "dev_iam" {
  source     = "../modules/project_iam"
  project_id = google_project.dev.project_id
  grants = {
    dev = {
      member = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}"
      roles  = ["roles/resourcemanager.projectIamAdmin"]
      condition = {
        title      = "approved-runtime-roles-only"
        expression = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(sort(tolist(local.grantable_roles)))})"
      }
    }
  }
  depends_on = [google_service_account.terraform]
}

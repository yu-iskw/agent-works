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
# IAM Conditions allow at most 10 elements in a hasOnly() list (live API: "ListLengthCheck"), so
# the allowlist is split into the fewest equal-size chunks of <= 10 roles, one conditioned binding each.
locals {
  condition_list_limit   = 10
  grantable_roles_sorted = sort(tolist(local.grantable_roles))
  grantable_chunk_count  = ceil(length(local.grantable_roles_sorted) / local.condition_list_limit)
  grantable_chunk_size   = ceil(length(local.grantable_roles_sorted) / local.grantable_chunk_count)
  grantable_role_chunks  = chunklist(local.grantable_roles_sorted, local.grantable_chunk_size)
}
module "dev_iam" {
  source     = "../modules/project_iam"
  project_id = var.project_id
  # Bindings are OR'd: a single setIamPolicy request may only change roles from ONE chunk.
  grants = {
    for index, chunk in local.grantable_role_chunks : "dev-${index + 1}" => {
      member = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}"
      roles  = ["roles/resourcemanager.projectIamAdmin"]
      condition = {
        title      = "approved-runtime-roles-only-${index + 1}"
        expression = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(chunk)})"
      }
    }
  }
  depends_on = [google_service_account.terraform]
}

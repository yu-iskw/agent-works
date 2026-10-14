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
  attach_bindings = merge(
    { for slot, email in local.service_account_emails : "terraform/${slot}" => { email = email, member = "serviceAccount:${var.terraform_dev_service_account}" }
    },
    { for slot in ["web", "api"] : "deployer/${slot}" => { email = local.service_account_emails[slot], member = "serviceAccount:${local.service_account_emails.deployer}" }
    }
  )
}
resource "google_service_account_iam_member" "attach" {
  for_each           = local.attach_bindings
  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value.email}"
  role               = "roles/iam.serviceAccountUser"
  member             = each.value.member
  depends_on         = [google_service_account.runtime, google_service_account.analytics, google_service_account.agent]
}
module "dev_iam" {
  source     = "../../modules/project_iam"
  project_id = var.project_id
  grants = {
    dev = {
      member = "serviceAccount:${var.terraform_dev_service_account}"
      roles  = ["roles/resourcemanager.projectIamAdmin"]
      condition = {
        title      = "approved-runtime-roles-only"
        expression = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(sort(tolist(local.grantable_roles)))})"
      }
    }
  }
}

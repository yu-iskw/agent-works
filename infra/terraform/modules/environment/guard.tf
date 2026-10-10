locals {
  guard_constraints = toset([
    "iam.automaticIamGrantsForDefaultServiceAccounts",
    "iam.disableServiceAccountKeyCreation",
    "iam.disableServiceAccountKeyUpload",
  ])
}

# Backstop for what Terraform cannot see. The module declares no key resource,
# and these constraints stop a key being created or uploaded by hand.
resource "google_org_policy_policy" "guard" {
  for_each = local.guard_constraints

  name   = "projects/${google_project.this.project_id}/policies/${each.key}"
  parent = "projects/${google_project.this.project_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }

  depends_on = [google_project_service.control_plane]
}

# Admin Activity logs are always on and record every policy change. Data
# Access logs cover reads and writes for every service.
resource "google_project_iam_audit_config" "all_services" {
  project = google_project.this.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }

  depends_on = [google_project_service.control_plane]
}

# auto_create_network = false makes the provider enable Compute, and Compute
# creates a default account that GCP grants a basic role on its own. That
# grant has no resource in this tree. Strip it, and the constraint above
# stops the grant recurring.
resource "google_project_default_service_accounts" "deprivilege" {
  project = google_project.this.project_id
  action  = "DEPRIVILEGE"

  depends_on = [google_org_policy_policy.guard]
}

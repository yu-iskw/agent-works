locals {
  guard_constraints = toset([
    "iam.automaticIamGrantsForDefaultServiceAccounts",
    "iam.disableServiceAccountKeyCreation",
    "iam.disableServiceAccountKeyUpload",
  ])
}

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

# auto_create_network = false makes the provider enable Compute, which creates a default account that GCP grants a basic role. That grant has no resource in this tree.
resource "google_project_default_service_accounts" "deprivilege" {
  project = google_project.this.project_id
  action  = "DEPRIVILEGE"

  depends_on = [google_org_policy_policy.guard]
}

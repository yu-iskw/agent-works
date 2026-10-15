module "github_wif" {
  source     = "../../modules/github_wif"
  project_id = var.project_id
  repository = "yu-iskw/agent-works"
}
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.runtime["deployer"].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${module.github_wif.pool_name}/attribute.access/dev"
}
resource "google_service_account_iam_member" "plan_wif" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.terraform_plan_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${module.github_wif.pool_name}/attribute.access/plan"
}

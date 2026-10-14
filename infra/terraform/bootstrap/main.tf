# Initial bootstrap uses local state and is the only non-impersonated provider.
resource "google_project" "dev" {
  name                = var.project_id
  project_id          = var.project_id
  folder_id           = var.folder_id
  billing_account     = var.billing_account_id
  auto_create_network = false
  deletion_policy     = "PREVENT"
}
module "baseline" {
  source                       = "../modules/project_baseline"
  project_id                   = google_project.dev.project_id
  apis                         = ["iam.googleapis.com", "iamcredentials.googleapis.com", "storage.googleapis.com", "serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com", "orgpolicy.googleapis.com"]
  guard_constraints            = ["iam.automaticIamGrantsForDefaultServiceAccounts", "iam.disableServiceAccountKeyCreation", "iam.disableServiceAccountKeyUpload"]
  deprivilege_default_accounts = true
}
resource "google_storage_bucket" "state" {
  #checkov:skip=CKV_GCP_62:DESIGN section 6 provisions only a state bucket; allServices Cloud Audit Logs cover access without a second access-log bucket.
  project                     = google_project.dev.project_id
  name                        = "${var.project_id}-tfstate"
  location                    = "asia-northeast1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle_rule {
    condition {
      num_newer_versions = 30
      with_state         = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [module.baseline]
}
locals {
  terraform_accounts = toset(["aw-tf-identity", "aw-tf-dev", "aw-tf-plan"])
  terraform_emails   = { for name in local.terraform_accounts : name => "${name}@${var.project_id}.iam.gserviceaccount.com" }
}
resource "google_service_account" "terraform" {
  for_each     = local.terraform_accounts
  project      = google_project.dev.project_id
  account_id   = each.key
  display_name = each.key
  depends_on   = [module.baseline]
}
resource "google_service_account_iam_member" "operator" {
  for_each           = local.terraform_accounts
  service_account_id = google_service_account.terraform[each.key].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = var.operator_member
}
resource "google_service_account_iam_member" "breakglass" {
  service_account_id = google_service_account.terraform["aw-tf-identity"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = var.breakglass_member
}
module "terraform_roles" {
  source     = "../modules/project_iam"
  project_id = google_project.dev.project_id
  grants = {
    identity = { member = "serviceAccount:${local.terraform_emails["aw-tf-identity"]}", roles = ["roles/iam.serviceAccountAdmin", "roles/iam.workloadIdentityPoolAdmin"] }
    dev      = { member = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}", roles = ["roles/serviceusage.serviceUsageAdmin", "roles/run.admin", "roles/artifactregistry.admin", "roles/secretmanager.admin", "roles/iap.admin", "roles/workflows.admin", "roles/cloudscheduler.admin", "roles/logging.configWriter"] }
    plan     = { member = "serviceAccount:${local.terraform_emails["aw-tf-plan"]}", roles = ["roles/viewer", "roles/iam.securityReviewer", "roles/secretmanager.viewer"] }
  }
  depends_on = [google_service_account.terraform]
}
resource "google_billing_account_iam_member" "budget" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.costsManager"
  member             = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}"
  depends_on         = [google_service_account.terraform]
}
resource "google_storage_bucket_iam_member" "applier" {
  for_each = { "aw-tf-identity" = "identity/", "aw-tf-dev" = "dev/" }
  bucket   = google_storage_bucket.state.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${local.terraform_emails[each.key]}"
  condition {
    title      = "state-prefix-${each.key}"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.state.name}/objects/${each.value}')"
  }
  depends_on = [google_service_account.terraform]
}
resource "google_storage_bucket_iam_member" "plan" {
  bucket     = google_storage_bucket.state.name
  role       = "roles/storage.objectViewer"
  member     = "serviceAccount:${local.terraform_emails["aw-tf-plan"]}"
  depends_on = [google_service_account.terraform]
}

# Workload root consumes the identity email map without writing identity state.
resource "google_storage_bucket_iam_member" "dev_identity_reader" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}"
  condition {
    title      = "read-identity-state"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.state.name}/objects/identity/')"
  }
  depends_on = [google_service_account.terraform]
}

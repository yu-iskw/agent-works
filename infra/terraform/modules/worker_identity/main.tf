locals {
  worker_ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}
resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = var.account_id
  display_name = var.account_id
  lifecycle {
    precondition {
      condition     = "${var.account_id}@${var.project_id}.iam.gserviceaccount.com" != var.api_service_account_email
      error_message = "The worker identity must be distinct from the human/API identity."
    }
  }
}
resource "google_project_iam_member" "worker" {
  for_each = var.project_roles
  project  = var.project_id
  member   = "serviceAccount:${google_service_account.worker.email}"
  role     = each.key
}
resource "google_cloud_run_v2_service_iam_member" "caller" {
  for_each = var.caller_service_account_emails
  project  = var.project_id
  location = var.region
  name     = var.worker_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.key}"
}
resource "google_cloud_run_v2_service_iam_member" "deployer" {
  project  = var.project_id
  location = var.region
  name     = var.worker_service_name
  role     = "roles/run.developer"
  member   = "serviceAccount:${var.deployer_email}"
}
resource "google_service_account_iam_member" "deployer_acts_as" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_email}"
}
# CMEK key ownership is an open operator decision (residual-risk-register R-15); until it is made
# the bucket uses Google-managed keys. Setting var.kms_key_name switches it to CMEK.
#trivy:ignore:GCP-0066
resource "google_storage_bucket" "artifacts" {
  #checkov:skip=CKV_GCP_62:Access logging for the artifact bucket is decided with the retention and audit settings.
  project                     = var.project_id
  name                        = var.artifact_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = true
  }
  dynamic "encryption" {
    for_each = var.kms_key_name == null ? [] : [var.kms_key_name]
    content {
      default_kms_key_name = encryption.value
    }
  }
}
resource "google_storage_bucket_iam_member" "artifact_users" {
  for_each = { worker = google_service_account.worker.email, api = var.api_service_account_email }
  bucket   = google_storage_bucket.artifacts.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${each.value}"
}

resource "google_cloud_scheduler_job" "job" {
  project   = var.project_id
  region    = var.region
  name      = var.name
  schedule  = var.schedule
  time_zone = "Asia/Tokyo"
  http_target {
    uri         = var.target
    http_method = "POST"
    oidc_token {
      service_account_email = var.invoker_service_account_email
      audience              = var.target
    }
  }
}

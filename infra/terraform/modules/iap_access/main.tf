resource "google_iap_web_cloud_run_service_iam_member" "accessor" {
  for_each               = var.members
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = var.service_name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.key
}

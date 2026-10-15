resource "google_project_service" "api" {
  for_each           = var.apis
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "google_org_policy_policy" "guard" {
  for_each = var.guard_constraints
  name     = "projects/${var.project_id}/policies/${each.key}"
  parent   = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_project_default_service_accounts" "deprivilege" {
  count      = var.deprivilege_default_accounts ? 1 : 0
  project    = var.project_id
  action     = "DEPRIVILEGE"
  depends_on = [google_org_policy_policy.guard]
}
resource "google_project_iam_audit_config" "all_services" {
  count   = var.enable_audit_config ? 1 : 0
  project = var.project_id
  service = "allServices"
  audit_log_config { log_type = "ADMIN_READ" }
  audit_log_config { log_type = "DATA_READ" }
  audit_log_config { log_type = "DATA_WRITE" }
  depends_on = [google_project_service.api]
}
moved {
  from = google_project_iam_audit_config.all_services
  to   = google_project_iam_audit_config.all_services[0]
}

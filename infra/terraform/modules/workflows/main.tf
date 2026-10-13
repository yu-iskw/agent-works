locals {
  workflow_name = "projects/${var.project_id}/locations/${var.region}/workflows/${var.name}"
  # Workflows IAM is project-scoped. Use a dedicated pilot project and an explicit
  # permission set rather than the broader built-in invoker role.
  adapter_permissions = [
    "workflows.executions.create",
    "workflows.executions.list",
    "workflows.executions.cancel",
    "workflows.callbacks.list",
    "workflows.callbacks.send",
  ]
}
resource "google_project_service" "workflows" {
  for_each           = toset(["workflows.googleapis.com", "workflowexecutions.googleapis.com"])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "google_service_account" "workflow" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "Dedicated Cloud Workflows task orchestrator"
}
resource "google_workflows_workflow" "tasks" {
  project             = var.project_id
  region              = var.region
  name                = var.name
  description         = "Ledger-authoritative pilot task orchestration; operator gated"
  service_account     = google_service_account.workflow.email
  source_contents     = var.source_contents
  call_log_level      = "LOG_NONE"
  deletion_protection = true
  labels              = { component = "durable-tasks", environment = "dev" }
  depends_on = [
    google_project_service.workflows,
    google_cloud_run_v2_service_iam_member.broker,
    google_service_account_iam_member.deployer,
  ]
}
resource "google_project_iam_custom_role" "adapter" {
  project     = var.project_id
  role_id     = "${replace(var.name, "-", "_")}_adapter"
  title       = "Pilot workflow dispatcher and callback sender"
  description = "Only execution control and callback delivery, without workflow deployment or IAM administration."
  permissions = local.adapter_permissions
}
resource "google_project_iam_member" "adapter" {
  project = var.project_id
  role    = google_project_iam_custom_role.adapter.name
  member  = "serviceAccount:${var.adapter_service_account_email}"
}
resource "google_service_account_iam_member" "deployer" {
  service_account_id = google_service_account.workflow.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_service_account_email}"
}
resource "google_cloud_run_v2_service_iam_member" "broker" {
  project  = var.project_id
  location = var.region
  name     = var.broker_service_name
  role     = "roles/run.invoker"
  member   = google_service_account.workflow.member
}

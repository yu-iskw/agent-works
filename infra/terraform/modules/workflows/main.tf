locals {
  # Metadata contract only; bootstrap owns the role with this exact permission set.
  adapter_permissions = [
    "workflows.executions.create", "workflows.executions.list",
    "workflows.executions.cancel", "workflows.callbacks.list", "workflows.callbacks.send",
  ]
  workflow_name = "projects/${var.project_id}/locations/${var.region}/workflows/${var.name}"

}
resource "google_project_service" "workflows" {
  for_each           = toset(["workflows.googleapis.com", "workflowexecutions.googleapis.com"])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

resource "google_workflows_workflow" "tasks" {
  project             = var.project_id
  region              = var.region
  name                = var.name
  description         = "Ledger-authoritative pilot task orchestration; operator gated"
  service_account     = var.workflow_service_account_email
  source_contents     = var.source_contents
  call_log_level      = "LOG_NONE"
  deletion_protection = true
  labels              = { component = "durable-tasks", environment = "dev" }
  depends_on = [
    google_project_service.workflows,
    google_cloud_run_v2_service_iam_member.broker,
  ]
}
resource "google_project_iam_member" "adapter" {
  project = var.project_id
  role    = "projects/${var.project_id}/roles/pilot_durable_tasks_adapter"
  member  = "serviceAccount:${var.adapter_service_account_email}"
}

resource "google_cloud_run_v2_service_iam_member" "broker" {
  project  = var.project_id
  location = var.region
  name     = var.broker_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.workflow_service_account_email}"
}

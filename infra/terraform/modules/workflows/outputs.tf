output "adapter" {
  description = "Non-secret adapter configuration; transport obtains OAuth via workload identity."
  value = {
    project_id             = var.project_id
    region                 = var.region
    workflow_name          = local.workflow_name
    execution_api_base_url = "https://workflowexecutions.googleapis.com/v1/${local.workflow_name}/executions"
    service_account_email  = var.workflow_service_account_email
    dispatcher_email       = var.adapter_service_account_email
  }
}
output "permissions" {
  description = "Expected bootstrap-owned dispatcher permissions; this module does not manage the role."
  value       = local.adapter_permissions
}
output "iam_bindings" {
  description = "Reviewable members, roles and scopes; callbacks share the dispatcher identity."
  value = {
    adapter = { member = google_project_iam_member.adapter.member, role = google_project_iam_member.adapter.role, scope = var.project_id }
    broker  = { member = google_cloud_run_v2_service_iam_member.broker.member, role = google_cloud_run_v2_service_iam_member.broker.role, scope = var.broker_service_name }
  }
}

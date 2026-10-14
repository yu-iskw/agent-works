variable "enable_workflows" {
  description = "Operator-only opt-in after cloud gate review; default deploys no workflow resources."
  type        = bool
  default     = false
}
variable "workflow_broker_service_name" {
  description = "Existing authenticated Cloud Run broker service; required only when enabled."
  type        = string
  default     = null
  nullable    = true
}
variable "workflow_source_contents" {
  description = "Reviewed generated workflow source; required only when enabled. Never include credentials."
  type        = string
  default     = null
  nullable    = true
}
module "workflows" {
  count  = var.enable_workflows ? 1 : 0
  source = "../../modules/workflows"

  depends_on = [module.baseline]

  project_id                     = var.project_id
  region                         = "asia-northeast1"
  adapter_service_account_email  = local.sa.api
  deployer_service_account_email = local.dev_applier_email
  workflow_service_account_email = local.sa.workflow
  broker_service_name            = var.workflow_broker_service_name
  source_contents                = var.workflow_source_contents
}
output "workflow_adapter" {
  description = "Null while opt-in is disabled; otherwise non-secret adapter metadata."
  value       = try(module.workflows[0].adapter, null)
}

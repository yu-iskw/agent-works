variable "project_id" {
  description = "Project id."
  type        = string
}
variable "pool_id" {
  description = "Pool id."
  type        = string
  default     = "aw-github"
}
variable "repository" {
  description = "Repository."
  type        = string
  default     = "yu-iskw/agent-works"
  validation {
    condition     = var.repository == "yu-iskw/agent-works"
    error_message = "Invalid repository: use the approved interface and pilot region."
  }
}
variable "attribute_condition" {
  description = "Additional federation condition; repository restriction, workflow ref and access attribute remain enforced."
  type        = string
  default     = "assertion.repository == 'yu-iskw/agent-works' && (('environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/deploy-dev.yml@refs/heads/main') || ((assertion.event_name == 'pull_request' && assertion.job_workflow_ref.startsWith('yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/pull/')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/heads/main')))"
}

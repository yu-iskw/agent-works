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
  description = "Additional federation condition; repository restriction and access attribute remain enforced."
  type        = string
  default     = "assertion.repository == 'yu-iskw/agent-works' && (assertion.event_name == 'pull_request' || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main') || ('environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main'))"
}

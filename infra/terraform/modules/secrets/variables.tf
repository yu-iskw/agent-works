variable "project_id" {
  description = "Project id."
  type        = string
}
variable "region" {
  description = "Region."
  type        = string
  default     = "asia-northeast1"
  validation {
    condition     = var.region == "asia-northeast1"
    error_message = "Invalid region: use the approved interface and pilot region."
  }
}
variable "secrets" {
  description = "Secrets."
  type        = map(object({ accessor_emails = set(string), version_adder_emails = optional(set(string), []) }))
  validation {
    condition     = alltrue(flatten([for secret in values(var.secrets) : [for email in setunion(secret.accessor_emails, secret.version_adder_emails) : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))]]))
    error_message = "Invalid secrets: use the approved interface and pilot region."
  }
}

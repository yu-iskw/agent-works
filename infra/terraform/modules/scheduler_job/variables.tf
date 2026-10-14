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
variable "name" {
  description = "Name."
  type        = string
  default     = "aw-scheduler"
}
variable "schedule" {
  description = "Schedule."
  type        = string
  default     = "0 * * * *"
}
variable "target" {
  description = "Target."
  type        = string
  validation {
    condition     = startswith(var.target, "https://")
    error_message = "Invalid target: use the approved interface and pilot region."
  }
}
variable "invoker_service_account_email" {
  description = "Invoker service account email."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.invoker_service_account_email))
    error_message = "Invalid invoker_service_account_email: use the approved interface and pilot region."
  }
}

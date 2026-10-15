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
variable "network" {
  description = "Existing VPC with private service networking; SQL requires networking."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^(projects/[^/]+/global/networks/[^/]+|https://www.googleapis.com/compute/v1/projects/[^/]+/global/networks/[^/]+)$", var.network))
    error_message = "Supply an existing VPC id; enable networking before Cloud SQL."
  }
}
variable "name" {
  description = "Name."
  type        = string
  default     = "aw-postgres"
}
variable "tier" {
  description = "Tier."
  type        = string
  default     = "db-custom-1-3840"
}
variable "client_emails" {
  description = "Client emails."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for email in var.client_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid client_emails: use the approved interface and pilot region."
  }
}

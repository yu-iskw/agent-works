variable "project_id" {
  description = "Project id."
  type        = string
}
variable "project_number" {
  description = "Project number."
  type        = string
}
variable "billing_account_id" {
  description = "Billing account id."
  type        = string
}
variable "terraform_service_account" {
  description = "Terraform service account."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.terraform_service_account))
    error_message = "Invalid terraform_service_account: use the approved interface and pilot region."
  }
}
variable "state_bucket" {
  description = "State bucket."
  type        = string
  default     = null
}
variable "service_account_emails" {
  description = "Offline test fallback; null reads the identity remote state."
  type        = map(string)
  default     = null
  validation {
    condition     = var.service_account_emails == null ? true : alltrue([for email in values(var.service_account_emails) : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid service_account_emails: use the approved interface and pilot region."
  }
}
variable "images" {
  description = "Digest-pinned web, api and tool_broker images. Empty provisions foundations only."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for image in values(var.images) : can(regex("@sha256:[0-9a-f]{64}$", image))])
    error_message = "Invalid images: use the approved interface and pilot region."
  }
}
variable "service_env" {
  description = "Service env."
  type        = map(map(string))
  default     = {}
}
variable "service_secret_env" {
  description = "Service secret env."
  type        = map(map(object({ secret_id = string, version = string })))
  default     = {}
}
variable "iap_members" {
  description = "Iap members."
  type        = set(string)
  default     = []
}
variable "enable_scheduler" {
  description = "Enable scheduler."
  type        = bool
  default     = false
}
variable "enable_kms" {
  description = "Enable kms."
  type        = bool
  default     = false
}
variable "enable_cloud_sql" {
  validation {
    condition     = !var.enable_cloud_sql || var.enable_network
    error_message = "Cloud SQL requires enable_network for private IP; D1 defaults SQL off."
  }
  description = "Enable cloud sql."
  type        = bool
  default     = false
}
variable "enable_network" {
  description = "Enable network."
  type        = bool
  default     = false
}
variable "enable_bigquery_analytics" {
  description = "Enable bigquery analytics."
  type        = bool
  default     = false
}
variable "enable_nat" {
  description = "Enable nat."
  type        = bool
  default     = false
}
variable "scheduler_target" {
  description = "Scheduler target."
  type        = string
  default     = null
}
variable "approved_datasets" {
  description = "Approved datasets."
  type        = set(string)
  default     = []
}

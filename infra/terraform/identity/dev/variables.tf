variable "project_id" {
  description = "Project id."
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
variable "terraform_dev_service_account" {
  description = "Terraform dev service account."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.terraform_dev_service_account))
    error_message = "Invalid terraform_dev_service_account: use the approved interface and pilot region."
  }
}
variable "terraform_plan_service_account" {
  description = "Terraform plan service account."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.terraform_plan_service_account))
    error_message = "Invalid terraform_plan_service_account: use the approved interface and pilot region."
  }
}
variable "enable_bigquery_analytics" {
  description = "Enable bigquery analytics."
  type        = bool
  default     = false
}
variable "enable_agent" {
  description = "Enable agent."
  type        = bool
  default     = false
}

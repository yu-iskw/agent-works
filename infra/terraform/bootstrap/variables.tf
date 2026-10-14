variable "project_id" {
  description = "Project id."
  type        = string
}
variable "folder_id" {
  description = "Folder id."
  type        = string
}
variable "billing_account_id" {
  description = "Billing account id."
  type        = string
}
variable "operator_member" {
  description = "Operator member."
  type        = string
  validation {
    condition     = can(regex("^user:[^@ ]+@[^@ ]+$", var.operator_member))
    error_message = "Invalid operator_member: use the approved interface and pilot region."
  }
}
variable "breakglass_member" {
  description = "Breakglass member."
  type        = string
  validation {
    condition     = can(regex("^group:[^@ ]+@[^@ ]+$", var.breakglass_member))
    error_message = "Invalid breakglass_member: use the approved interface and pilot region."
  }
}

variable "enable_network" {
  description = "Enable bootstrap provisioning for network; match the dev root flag."
  type        = bool
  default     = false
}

variable "enable_nat" {
  description = "Enable bootstrap provisioning for nat; match the dev root flag."
  type        = bool
  default     = false
}

variable "enable_cloud_sql" {
  description = "Enable bootstrap provisioning for cloud_sql; match the dev root flag."
  type        = bool
  default     = false
}

variable "enable_kms" {
  description = "Enable bootstrap provisioning for kms; match the dev root flag."
  type        = bool
  default     = false
}

variable "enable_bigquery_analytics" {
  description = "Enable bootstrap provisioning for bigquery_analytics; match the dev root flag."
  type        = bool
  default     = false
}

variable "enable_workflows" {
  description = "Enable bootstrap provisioning for workflows; match the dev root flag."
  type        = bool
  default     = false
}

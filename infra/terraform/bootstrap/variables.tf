variable "project_id" {
  description = "Project id."
  type        = string
}
variable "billing_account_id" {
  description = "Billing account id; required only when enable_billing_budget_iam is true (the budget module in environments/dev takes its own billing_account_id)."
  type        = string
  default     = null
  validation {
    condition     = !var.enable_billing_budget_iam || var.billing_account_id != null
    error_message = "billing_account_id must be set when enable_billing_budget_iam is true."
  }
}
variable "enable_default_sa_deprivilege" {
  description = "Deprivilege default service accounts in module.baseline; default false for adopted projects."
  type        = bool
  default     = false
}
variable "enable_audit_config" {
  description = "Enable allServices Cloud Audit Logs in module.baseline; default false for adopted projects."
  type        = bool
  default     = false
}
variable "guard_constraints" {
  description = "Organization policy guard constraints to enforce in module.baseline; recommended set when the operator holds roles/orgpolicy.policyAdmin: iam.automaticIamGrantsForDefaultServiceAccounts, iam.disableServiceAccountKeyCreation, iam.disableServiceAccountKeyUpload."
  type        = set(string)
  default     = []
}
variable "enable_billing_budget_iam" {
  description = "Grant roles/billing.costsManager on billing_account_id to aw-tf-dev; default false."
  type        = bool
  default     = false
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

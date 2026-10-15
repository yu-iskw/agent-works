variable "project_id" {
  description = "Project id."
  type        = string
}
variable "apis" {
  description = "Apis."
  type        = set(string)
}
variable "guard_constraints" {
  description = "Guard constraints."
  type        = set(string)
  default     = []
  validation {
    condition = length(setsubtract(var.guard_constraints, toset([
      "iam.automaticIamGrantsForDefaultServiceAccounts",
      "iam.disableServiceAccountKeyCreation",
      "iam.disableServiceAccountKeyUpload",
    ]))) == 0
    error_message = "guard_constraints may contain only iam.automaticIamGrantsForDefaultServiceAccounts, iam.disableServiceAccountKeyCreation and iam.disableServiceAccountKeyUpload."
  }
}
variable "deprivilege_default_accounts" {
  description = "Deprivilege default accounts."
  type        = bool
  default     = false
}
variable "enable_audit_config" {
  description = "Enable allServices Cloud Audit Logs; default true for workload roots, overridden to false by bootstrap for adopted projects."
  type        = bool
  default     = true
}

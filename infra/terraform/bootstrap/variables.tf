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

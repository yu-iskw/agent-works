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
}
variable "deprivilege_default_accounts" {
  description = "Deprivilege default accounts."
  type        = bool
  default     = false
}

variable "project_id" {
  description = "Project id."
  type        = string
}
variable "billing_account_id" {
  description = "Billing account id."
  type        = string
}
variable "project_number" {
  description = "Project number."
  type        = string
}
variable "currency_code" {
  description = "Currency code."
  type        = string
  default     = "USD"
}
variable "reference_amount" {
  description = "Reference amount."
  type        = number
  default     = 100
  validation {
    condition     = var.reference_amount > 0 && floor(var.reference_amount) == var.reference_amount
    error_message = "Invalid reference_amount: use the approved interface and pilot region."
  }
}
variable "alert_at" {
  description = "Alert at."
  type        = list(number)
  default     = [0.5, 0.9, 1.0, 1.5]
  validation {
    condition     = length(var.alert_at) > 0 && alltrue([for fraction in var.alert_at : fraction > 0])
    error_message = "Invalid alert_at: use the approved interface and pilot region."
  }
}

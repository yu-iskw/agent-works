variable "project_id" {
  description = "Id of the dev project."
  type        = string
}

variable "folder_id" {
  description = "Numeric id of the folder for the pilot test tenant."
  type        = string
}

variable "billing_account_id" {
  description = "Billing account that pays for the dev project."
  type        = string
}

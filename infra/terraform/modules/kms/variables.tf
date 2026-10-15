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
variable "keyring" {
  description = "Keyring."
  type        = string
  default     = "aw-governance"
}
variable "key" {
  description = "Key."
  type        = string
  default     = "governance"
}
variable "encrypter_decrypter_emails" {
  description = "Encrypter decrypter emails."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for email in var.encrypter_decrypter_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid encrypter_decrypter_emails: use the approved interface and pilot region."
  }
}

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
variable "repository_id" {
  description = "Repository id."
  type        = string
  default     = "aw-images"
}
variable "writer_emails" {
  description = "Writer emails."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for email in var.writer_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid writer_emails: use the approved interface and pilot region."
  }
}
variable "reader_emails" {
  description = "Reader emails."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for email in var.reader_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid reader_emails: use the approved interface and pilot region."
  }
}

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
variable "service_name" {
  description = "Service name."
  type        = string
}
variable "members" {
  description = "Members."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for member in var.members : can(regex("^(user|group):[^@ ]+@[^@ ]+$", member))])
    error_message = "Invalid members: use the approved interface and pilot region."
  }
}

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
variable "name" {
  description = "Name."
  type        = string
  default     = "aw-dev"
}
variable "subnet_cidr" {
  description = "Subnet cidr."
  type        = string
  default     = "10.80.0.0/24"
}
variable "enable_nat" {
  description = "Enable nat."
  type        = bool
  default     = false
}

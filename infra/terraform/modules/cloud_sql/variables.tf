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
variable "network" {
  description = "Existing VPC with private service networking; SQL requires networking."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^(projects/[^/]+/global/networks/[^/]+|https://www.googleapis.com/compute/v1/projects/[^/]+/global/networks/[^/]+)$", var.network))
    error_message = "Supply an existing VPC id; enable networking before Cloud SQL."
  }
}
variable "name" {
  description = "Name."
  type        = string
  default     = "aw-postgres"
}
variable "tier" {
  description = "Tier."
  type        = string
  default     = "db-custom-1-3840"
}
variable "client_emails" {
  description = "Client emails."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for email in var.client_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid client_emails: use the approved interface and pilot region."
  }
}
variable "availability_type" {
  description = "REGIONAL is the HA proposal; ZONAL is a cost-saving override that needs an approved recovery target."
  type        = string
  default     = "REGIONAL"
  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.availability_type)
    error_message = "availability_type must be REGIONAL or ZONAL."
  }
}
variable "backup_start_time" {
  description = "Daily backup window start (UTC, HH:MM). null leaves the provider default."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.backup_start_time == null || can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_start_time))
    error_message = "backup_start_time must be HH:MM in UTC."
  }
}
variable "retained_backups" {
  description = "Automated backups kept. Proposal pending approved retention (D-08); 7 equals the current provider default."
  type        = number
  default     = 7
  validation {
    condition     = var.retained_backups >= 1 && var.retained_backups <= 365 && floor(var.retained_backups) == var.retained_backups
    error_message = "retained_backups must be an integer from 1 to 365."
  }
}
variable "transaction_log_retention_days" {
  description = "PITR WAL retention in days. Bounds how far back a point-in-time restore can reach."
  type        = number
  default     = 7
  validation {
    condition     = var.transaction_log_retention_days >= 1 && var.transaction_log_retention_days <= 35 && floor(var.transaction_log_retention_days) == var.transaction_log_retention_days
    error_message = "transaction_log_retention_days must be an integer from 1 to 35."
  }
}
variable "max_connections" {
  description = "Explicit max_connections flag. null keeps the tier default; set it from the pool-budget worksheet only after the operator confirms SHOW max_connections."
  type        = number
  default     = null
  nullable    = true
  validation {
    condition     = var.max_connections == null ? true : (var.max_connections >= 14 && floor(var.max_connections) == var.max_connections)
    error_message = "max_connections must be an integer of at least 14."
  }
}

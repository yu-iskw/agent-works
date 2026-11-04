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
  description = "Queue name."
  type        = string
  default     = "aw-dispatch"
}
variable "dispatcher_service_account_email" {
  description = "Service account that enqueues tasks, is the OIDC identity on each task, and is the only run.invoker on the worker."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.dispatcher_service_account_email))
    error_message = "Invalid dispatcher_service_account_email: use the approved interface and pilot region."
  }
}
variable "worker_service_name" {
  description = "Cloud Run service that hosts the delivery endpoint."
  type        = string
}
variable "max_attempts" {
  description = "Maximum delivery attempts."
  type        = number
  default     = 8
  validation {
    condition     = var.max_attempts >= 1
    error_message = "Invalid max_attempts: use the approved interface and pilot region."
  }
}
variable "min_backoff_seconds" {
  description = "Minimum retry backoff."
  type        = number
  default     = 5
}
variable "max_backoff_seconds" {
  description = "Maximum retry backoff."
  type        = number
  default     = 600
  validation {
    condition     = var.max_backoff_seconds >= var.min_backoff_seconds
    error_message = "Invalid max_backoff_seconds: use the approved interface and pilot region."
  }
}
variable "max_doublings" {
  description = "Backoff doublings before linear growth."
  type        = number
  default     = 6
}
variable "max_retry_duration_seconds" {
  description = "Give up after this long."
  type        = number
  default     = 21600
}
variable "max_dispatches_per_second" {
  description = "Dispatch rate cap (backpressure)."
  type        = number
  default     = 5
}
variable "max_concurrent_dispatches" {
  description = "Concurrent dispatch cap (backpressure on the database)."
  type        = number
  default     = 10
  validation {
    condition     = var.max_concurrent_dispatches >= 1
    error_message = "Invalid max_concurrent_dispatches: use the approved interface and pilot region."
  }
}

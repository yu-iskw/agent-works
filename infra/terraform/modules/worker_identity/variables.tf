variable "project_id" {
  description = "Project id."
  type        = string
}
variable "project_number" {
  description = "Project number, used to derive the deterministic Cloud Run URL that is the OIDC audience."
  type        = string
  validation {
    condition     = can(regex("^[0-9]+$", var.project_number))
    error_message = "Invalid project_number: digits only."
  }
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
variable "worker_service_account_email" {
  description = "Worker runtime service account email, created in identity/dev (identities never live in modules). It must differ from the human/API identity."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.worker_service_account_email))
    error_message = "Invalid worker_service_account_email: use a service account email."
  }
  validation {
    condition     = var.worker_service_account_email != var.api_service_account_email
    error_message = "The worker identity must be distinct from the human/API identity."
  }
}
variable "worker_service_name" {
  description = "Cloud Run service name of the worker endpoint."
  type        = string
  default     = "aw-worker"
}
variable "api_service_account_email" {
  description = "Human/API runtime identity. The worker identity must differ from it and it can never invoke the worker."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.api_service_account_email))
    error_message = "Invalid api_service_account_email: use a service account email."
  }
}
variable "deployer_email" {
  description = "WIF-impersonated deployer service account."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.deployer_email))
    error_message = "Invalid deployer_email: use a service account email."
  }
}
variable "caller_service_account_emails" {
  description = "Service accounts allowed to invoke the worker endpoint (dispatcher, scheduler, workflow). Never the API identity."
  type        = set(string)
  validation {
    condition     = length(var.caller_service_account_emails) > 0 && alltrue([for email in var.caller_service_account_emails : can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", email))])
    error_message = "Invalid caller_service_account_emails: a non-empty set of service account emails (no public or user principals)."
  }
  validation {
    condition     = !contains(var.caller_service_account_emails, var.api_service_account_email)
    error_message = "Invalid caller_service_account_emails: the human/API identity must not invoke the worker."
  }
}
variable "project_roles" {
  description = "Project roles for the worker identity. Primitive and administrative roles are rejected."
  type        = set(string)
  default     = ["roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent"]
  validation {
    condition     = alltrue([for role in var.project_roles : !contains(["roles/owner", "roles/editor", "roles/viewer"], role) && !can(regex("(Admin|admin|tokenCreator)", role))])
    error_message = "Invalid project_roles: no primitive, admin or tokenCreator roles."
  }
}
variable "artifact_bucket_name" {
  description = "Private artifact bucket name."
  type        = string
}
variable "kms_key_name" {
  description = "Optional customer-managed Cloud KMS key (full resource name) for the artifact bucket. Null keeps Google-managed encryption; key ownership is an open operator decision."
  type        = string
  default     = null
}

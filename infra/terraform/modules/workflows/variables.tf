variable "project_id" {
  description = "Existing isolated pilot project. This module creates no project."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a valid pilot project id."
  }
}
variable "region" {
  description = "Accepted ADR 0003 pilot region."
  type        = string
  default     = "asia-northeast1"
  validation {
    condition     = var.region == "asia-northeast1"
    error_message = "The pilot region is asia-northeast1."
  }
}
variable "name" {
  description = "Workflow resource name and IAM role namespace."
  type        = string
  default     = "pilot-durable-tasks"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.name))
    error_message = "Use a lowercase 6-30 character workflow name."
  }
}
variable "service_account_id" {
  description = "Dedicated workflow execution identity, never the task-service identity."
  type        = string
  default     = "pilot-workflow"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.service_account_id))
    error_message = "Use a lowercase 6-30 character service-account id."
  }
}
variable "adapter_service_account_email" {
  validation {
    condition     = var.adapter_service_account_email != "${var.service_account_id}@${var.project_id}.iam.gserviceaccount.com" && var.adapter_service_account_email != var.deployer_service_account_email
    error_message = "Execution, dispatcher and deployment identities must be distinct."
  }

  description = "Existing keyless task-service identity that dispatches executions and sends callback hints."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.adapter_service_account_email))
    error_message = "Only an explicit service-account email is accepted."
  }
}
variable "deployer_service_account_email" {
  validation {
    condition     = var.deployer_service_account_email != "${var.service_account_id}@${var.project_id}.iam.gserviceaccount.com"
    error_message = "Deployment and execution identities must be distinct."
  }

  description = "Existing operator-approved deployment identity allowed to attach the workflow identity."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.deployer_service_account_email))
    error_message = "Only an explicit service-account email is accepted."
  }
}
variable "broker_service_name" {
  description = "Existing authenticated Cloud Run broker; invoker is granted only on this service."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+$", var.broker_service_name))
    error_message = "Use a Cloud Run service name, not a URL."
  }
}
variable "source_contents" {
  description = "Reviewed JSON/YAML definition produced by generateCloudWorkflowDefinition. Contains fixed endpoint metadata only, never credentials or task payloads."
  type        = string
  validation {
    condition     = try(length(trimspace(var.source_contents)) > 0, false)
    error_message = "A reviewed workflow definition is required."
  }
}

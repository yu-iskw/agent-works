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
}
variable "image" {
  description = "Image."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Invalid image: use the approved interface and pilot region."
  }
}
variable "service_account_email" {
  description = "Service account email."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.service_account_email))
    error_message = "Invalid service_account_email: use the approved interface and pilot region."
  }
}
variable "deployer_email" {
  description = "Deployer email."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.deployer_email))
    error_message = "Invalid deployer_email: use the approved interface and pilot region."
  }
}
variable "env" {
  description = "Env."
  type        = map(string)
  default     = {}
}
variable "secret_env" {
  description = "Secret env."
  type        = map(object({ secret_id = string, version = string }))
  default     = {}
  validation {
    condition     = alltrue([for secret in values(var.secret_env) : can(regex("^[1-9][0-9]*$", secret.version))])
    error_message = "Invalid secret_env: use the approved interface and pilot region."
  }
}
variable "ingress" {
  description = "Ingress."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.ingress)
    error_message = "Invalid ingress: use the approved interface and pilot region."
  }
}
variable "iap_enabled" {
  description = "Iap enabled."
  type        = bool
  default     = true
}
variable "iap_service_agent_email" {
  description = "Iap service agent email."
  type        = string
  default     = null
  validation {
    condition     = var.iap_enabled ? can(regex("^service-[0-9]+@gcp-sa-iap\\.iam\\.gserviceaccount\\.com$", var.iap_service_agent_email)) : true
    error_message = "Invalid iap_service_agent_email: use the approved interface and pilot region."
  }
}
variable "invoker_members" {
  description = "Invoker members."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for member in var.invoker_members : can(regex("^serviceAccount:[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", member))])
    error_message = "Invalid invoker_members: use the approved interface and pilot region."
  }
}
variable "network" {
  description = "Network."
  type        = object({ network = string, subnetwork = string })
  default     = null
}

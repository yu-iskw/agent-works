variable "project_id" {
  description = "Id of the dev project this module creates."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be 6 to 30 characters, start with a lowercase letter, and use lowercase letters, digits, and hyphens."
  }
}

variable "folder_id" {
  description = "Numeric id of the folder the project is created under. A folder, never an organization."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.folder_id))
    error_message = "folder_id must be the numeric folder id."
  }
}

variable "billing_account_id" {
  description = "Billing account the project is attached to and the budget alerts on."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must look like 012345-6789AB-CDEF01."
  }
}

variable "identities" {
  description = <<-EOT
    The registry of service identities, written once by the calling root.
    Keys are the fixed identity slots. Each value is the service account id and
    the capability names the identity holds. A capability is a name from the
    module catalogue, not a role id, so a basic role cannot be written here.
  EOT
  type = map(object({
    account_id = string
    grants     = set(string)
  }))

  validation {
    condition     = toset(keys(var.identities)) == toset(keys(local.slots))
    error_message = "identities must have exactly these keys: ${join(", ", sort(keys(local.slots)))}."
  }

  validation {
    condition     = length(distinct([for i in values(var.identities) : i.account_id])) == length(var.identities)
    error_message = "Every identity needs its own account_id."
  }

  validation {
    condition     = alltrue([for i in values(var.identities) : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", i.account_id))])
    error_message = "account_id must be 6 to 30 characters, start with a lowercase letter, and use lowercase letters, digits, and hyphens."
  }

  validation {
    condition = alltrue(flatten([
      for slot, i in var.identities : [
        for g in i.grants : contains(keys(try(local.capabilities[local.slots[slot]], {})), g)
      ]
    ]))
    error_message = "A grant must be a capability name for that identity's kind. Runtime: ${join(", ", sort(keys(local.capabilities.runtime)))}. Deployer: ${join(", ", sort(keys(local.capabilities.deployer)))}."
  }
}

variable "budget" {
  description = <<-EOT
    Spend tracking. reference_amount is the monthly figure that alert_at
    fractions are taken of. It is not a cap. This module has no resource that
    can stop spend or disable billing.
  EOT
  type = object({
    currency_code    = string
    reference_amount = number
    alert_at         = list(number)
  })

  validation {
    condition     = var.budget.reference_amount > 0 && floor(var.budget.reference_amount) == var.budget.reference_amount
    error_message = "reference_amount must be a positive whole number."
  }

  validation {
    condition     = length(var.budget.alert_at) > 0 && alltrue([for f in var.budget.alert_at : f > 0])
    error_message = "alert_at needs at least one positive fraction."
  }
}

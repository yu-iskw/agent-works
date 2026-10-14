variable "project_id" {
  description = "Project id."
  type        = string
}
variable "grants" {
  description = "Grants."
  type        = map(object({ member = string, roles = set(string), condition = optional(object({ title = string, expression = string })) }))
  validation {
    condition     = alltrue([for grant in values(var.grants) : can(regex("^serviceAccount:[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", grant.member)) && !contains(grant.roles, "roles/owner") && !contains(grant.roles, "roles/editor")])
    error_message = "Invalid grants: use the approved interface and pilot region."
  }
}

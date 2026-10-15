output "project_number" {
  description = "Reviewable project number."
  value       = data.google_project.dev.number
}
output "state_bucket" {
  description = "Reviewable state bucket."
  value       = google_storage_bucket.state.name
}
output "terraform_service_account_emails" {
  description = "Reviewable terraform service account emails."
  value       = local.terraform_emails
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = merge(module.terraform_roles.iam_bindings, module.dev_iam.iam_bindings, { for key, binding in google_storage_bucket_iam_member.applier_list : "state-list/${key}" => { member = binding.member, role = binding.role, scope = binding.bucket } }, { for key, binding in google_project_iam_member.provisioning : "provisioning/${key}" => { member = binding.member, role = binding.role, scope = binding.project } }, { for key, binding in google_service_account_iam_member.operator : "operator/${key}" => { member = binding.member, role = binding.role, scope = key }
    }, { breakglass = { member = google_service_account_iam_member.breakglass.member, role = google_service_account_iam_member.breakglass.role, scope = "aw-tf-identity" }
    }, { for key, binding in google_storage_bucket_iam_member.applier : "state/${key}" => { member = binding.member, role = binding.role, scope = binding.bucket }
    }, { identity_state_reader = { member = google_storage_bucket_iam_member.dev_identity_reader.member, role = google_storage_bucket_iam_member.dev_identity_reader.role, scope = google_storage_bucket_iam_member.dev_identity_reader.bucket }, plan_state = { member = google_storage_bucket_iam_member.plan.member, role = google_storage_bucket_iam_member.plan.role, scope = google_storage_bucket_iam_member.plan.bucket }
    }, { for key, binding in google_billing_account_iam_member.budget : "budget" => { member = binding.member, role = binding.role, scope = var.billing_account_id }
  })
}

output "grantable_roles" {
  description = "Approved workload role allowlist owned by bootstrap."
  value       = local.grantable_roles
}

output "grantable_role_chunks" {
  description = "Approved role allowlist split into hasOnly() chunks of at most 10 elements (IAM Conditions list limit)."
  value       = local.grantable_role_chunks
}

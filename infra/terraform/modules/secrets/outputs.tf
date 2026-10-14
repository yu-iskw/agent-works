output "secret_ids" {
  description = "Reviewable secret ids."
  value       = { for key, secret in google_secret_manager_secret.container : key => secret.secret_id }
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = { for key, binding in google_secret_manager_secret_iam_member.grant : key => { member = binding.member, role = binding.role, scope = local.bindings[key].secret }
  }
}

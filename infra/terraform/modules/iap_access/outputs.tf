output "members" {
  description = "Reviewable members."
  value       = toset(keys(google_iap_web_cloud_run_service_iam_member.accessor))
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = { for key, binding in google_iap_web_cloud_run_service_iam_member.accessor : key => { member = binding.member, role = binding.role, scope = var.service_name }
  }
}

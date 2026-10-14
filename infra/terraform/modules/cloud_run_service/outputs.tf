output "name" {
  description = "Reviewable name."
  value       = google_cloud_run_v2_service.service.name
}
output "uri" {
  description = "Reviewable uri."
  value       = google_cloud_run_v2_service.service.uri
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = merge({ for key, binding in google_cloud_run_v2_service_iam_member.invoker : key => { member = binding.member, role = binding.role, scope = var.name }
    }, { deployer = { member = google_cloud_run_v2_service_iam_member.deployer.member, role = google_cloud_run_v2_service_iam_member.deployer.role, scope = var.name }
  })
}

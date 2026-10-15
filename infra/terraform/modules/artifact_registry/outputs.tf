output "repository_url" {
  description = "Reviewable repository url."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}"
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = { for key, binding in google_artifact_registry_repository_iam_member.grant : key => { member = binding.member, role = binding.role, scope = var.repository_id }
  }
}

output "pool_name" {
  description = "Reviewable pool name."
  value       = google_iam_workload_identity_pool.github.name
}
output "provider_name" {
  description = "Reviewable provider name."
  value       = google_iam_workload_identity_pool_provider.github.name
}
output "attribute_mapping" {
  description = "Reviewable OIDC attribute mapping."
  value       = google_iam_workload_identity_pool_provider.github.attribute_mapping
}
output "attribute_condition" {
  description = "Reviewable OIDC attribute condition."
  value       = google_iam_workload_identity_pool_provider.github.attribute_condition
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

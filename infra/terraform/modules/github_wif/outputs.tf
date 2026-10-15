output "pool_name" {
  description = "Reviewable pool name."
  value       = google_iam_workload_identity_pool.github.name
}
output "provider_name" {
  description = "Reviewable provider name."
  value       = google_iam_workload_identity_pool_provider.github.name
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

output "service_account_email" {
  description = "Worker runtime service account email."
  value       = google_service_account.worker.email
}
output "oidc_audience" {
  description = "Audience callers must request in their ID token: the worker Cloud Run URL."
  value       = "https://${var.worker_service_name}-${var.project_number}.${var.region}.run.app"
}
output "required_ingress" {
  description = "Ingress the worker Cloud Run service must use; it is never behind the human IAP path."
  value       = local.worker_ingress
}
output "authorized_callers" {
  description = "Principals bound to roles/run.invoker on the worker service."
  value       = sort(tolist(var.caller_service_account_emails))
}
output "artifact_bucket" {
  description = "Private artifact bucket."
  value       = google_storage_bucket.artifacts.name
}

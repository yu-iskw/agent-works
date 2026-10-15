output "enabled_apis" {
  description = "Reviewable enabled apis."
  value       = toset(keys(google_project_service.api))
}
output "org_policies" {
  description = "Reviewable org policies."
  value       = { for key, policy in google_org_policy_policy.guard : key => policy.spec[0].rules[0].enforce }
}
output "audit_log" {
  description = "Reviewable audit log."
  value       = length(google_project_iam_audit_config.all_services) == 0 ? null : { service = google_project_iam_audit_config.all_services[0].service, log_types = toset([for log in google_project_iam_audit_config.all_services[0].audit_log_config : log.log_type]) }
}
output "default_accounts_action" {
  description = "Reviewable default service accounts action."
  value       = one(google_project_default_service_accounts.deprivilege[*].action)
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

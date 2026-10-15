output "service_account_emails" {
  description = "Reviewable service account emails."
  value       = local.service_account_emails
}
output "wif_provider" {
  description = "Reviewable wif provider."
  value       = module.github_wif.provider_name
}
output "wif_attribute_mapping" {
  description = "Reviewable WIF attribute mapping separating deploy-dev.yml and infra-plan.yml."
  value       = module.github_wif.attribute_mapping
}
output "wif_attribute_condition" {
  description = "Reviewable WIF attribute condition."
  value       = module.github_wif.attribute_condition
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = merge({ for key, binding in google_service_account_iam_member.attach : key => { member = binding.member, role = binding.role, scope = local.attach_bindings[key].email }
    }, { deployer_wif = { member = google_service_account_iam_member.deployer_wif.member, role = google_service_account_iam_member.deployer_wif.role, scope = local.service_account_emails.deployer }, plan_wif = { member = google_service_account_iam_member.plan_wif.member, role = google_service_account_iam_member.plan_wif.role, scope = var.terraform_plan_service_account }
  })
}

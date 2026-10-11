output "service_accounts" {
  description = "Planned service accounts by registry slot."
  value = {
    for slot, sa in google_service_account.this : slot => {
      account_id = sa.account_id
      email      = sa.email
    }
  }
}

output "iam_bindings" {
  description = "Every IAM binding the module plans."
  value = merge(
    {
      for key, binding in google_project_iam_member.grant : key => {
        slot   = local.grants[key].slot
        scope  = "project"
        role   = binding.role
        target = binding.project
      }
    },
    {
      for slot, binding in google_service_account_iam_member.deployer_acts_as : "deployer/${slot}/${binding.role}" => {
        slot   = "deployer"
        scope  = "service_account"
        role   = binding.role
        target = slot
      }
    },
  )
}

output "org_policies" {
  description = "Enforcement state of each guard constraint."
  value = {
    for constraint, policy in google_org_policy_policy.guard : constraint => policy.spec[0].rules[0].enforce
  }
}

output "audit_log" {
  description = "Service and log types on the planned project audit config."
  value = {
    service   = google_project_iam_audit_config.all_services.service
    log_types = sort([for entry in google_project_iam_audit_config.all_services.audit_log_config : entry.log_type])
  }
}

output "budget" {
  description = "Planned alert thresholds and the Pub/Sub topics wired to the budget."
  value = {
    thresholds    = [for rule in google_billing_budget.spend.threshold_rules : rule.threshold_percent]
    pubsub_topics = [for rule in google_billing_budget.spend.all_updates_rule : rule.pubsub_topic]
  }
}

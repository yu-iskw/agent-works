output "thresholds" {
  description = "Reviewable thresholds."
  value       = [for rule in google_billing_budget.spend.threshold_rules : rule.threshold_percent]
}
output "pubsub_topics" {
  description = "Reviewable pubsub topics."
  value       = [for rule in google_billing_budget.spend.all_updates_rule : rule.pubsub_topic]
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

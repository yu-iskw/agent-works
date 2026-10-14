output "dataset_ids" {
  description = "Reviewable dataset ids."
  value       = toset(keys(google_bigquery_dataset.approved))
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = merge({ for key, binding in google_bigquery_dataset_iam_member.reader : key => { member = binding.member, role = binding.role, scope = local.readers[key].dataset }
  }, module.jobs.iam_bindings)
}

output "key_id" {
  description = "Reviewable key id."
  value       = google_kms_crypto_key.governance.id
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = { for key, binding in google_kms_crypto_key_iam_member.grant : key => { member = binding.member, role = binding.role, scope = google_kms_crypto_key.governance.id }
  }
}

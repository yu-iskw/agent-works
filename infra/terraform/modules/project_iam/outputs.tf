output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = { for key, binding in google_project_iam_member.grant : key => { member = binding.member, role = binding.role, scope = var.project_id, condition = local.bindings[key].condition }
  }
}

locals {
  bindings = merge({}, [for key, grant in var.grants : { for role in grant.roles : "${key}/${role}" => { member = grant.member, role = role, condition = grant.condition }
  }]...)
}
resource "google_project_iam_member" "grant" {
  #checkov:skip=CKV_GCP_42:DESIGN section 4 requires scoped Terraform administrator accounts; runtime grants remain least-privilege and the dev IAM admin grant is conditioned by D6.
  #checkov:skip=CKV_GCP_49:Only bootstrap aw-tf-identity receives serviceAccountAdmin per the approved three-root boundary; tokenCreator is never project-scoped.
  #checkov:skip=CKV_GCP_117:D11 explicitly assigns read-only Viewer to aw-tf-plan; Owner and Editor are rejected by input validation.
  for_each = local.bindings
  project  = var.project_id
  member   = each.value.member
  role     = each.value.role
  dynamic "condition" {
    for_each = each.value.condition == null ? [] : [each.value.condition]
    content {
      title      = condition.value.title
      expression = condition.value.expression
    }
  }
}

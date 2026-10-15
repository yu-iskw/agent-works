resource "google_secret_manager_secret" "container" {
  for_each  = var.secrets
  project   = var.project_id
  secret_id = each.key
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}
locals {
  bindings = merge({}, [for key, secret in var.secrets : merge(
    { for email in secret.accessor_emails : "${key}/accessor/${email}" => { secret = key, email = email, role = "roles/secretmanager.secretAccessor" } },
    { for email in secret.version_adder_emails : "${key}/adder/${email}" => { secret = key, email = email, role = "roles/secretmanager.secretVersionAdder" } }
  )]...)
}
resource "google_secret_manager_secret_iam_member" "grant" {
  for_each  = local.bindings
  project   = var.project_id
  secret_id = google_secret_manager_secret.container[each.value.secret].secret_id
  member    = "serviceAccount:${each.value.email}"
  role      = each.value.role
}

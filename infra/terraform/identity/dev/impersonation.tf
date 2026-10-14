locals {
  attach_bindings = merge(
    { for slot, email in local.service_account_emails : "terraform/${slot}" => { email = email, member = "serviceAccount:${var.terraform_dev_service_account}" }
    },
    { for slot in ["web", "api"] : "deployer/${slot}" => { email = local.service_account_emails[slot], member = "serviceAccount:${local.service_account_emails.deployer}" }
    }
  )
}
resource "google_service_account_iam_member" "attach" {
  for_each           = local.attach_bindings
  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value.email}"
  role               = "roles/iam.serviceAccountUser"
  member             = each.value.member
  depends_on         = [google_service_account.runtime, google_service_account.analytics, google_service_account.agent]
}

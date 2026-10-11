resource "google_billing_budget" "spend" {
  billing_account = var.billing_account_id
  display_name    = "${var.project_id} spend"

  budget_filter {
    projects = ["projects/${google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget.currency_code
      units         = tostring(var.budget.reference_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget.alert_at

    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  depends_on = [google_project_service.control_plane]
}

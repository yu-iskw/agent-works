resource "google_billing_budget" "spend" {
  billing_account = var.billing_account_id
  display_name    = "${var.project_id} spend"
  budget_filter { projects = ["projects/${var.project_number}"] }
  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.reference_amount)
    }
  }
  dynamic "threshold_rules" {
    for_each = var.alert_at
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }
}

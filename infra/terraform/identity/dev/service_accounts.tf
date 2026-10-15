locals {
  runtime_accounts = {
    deployer    = "aw-deployer"
    web         = "aw-web"
    api         = "aw-api"
    tool_broker = "aw-tool-broker"
    workflow    = "aw-workflow"
    scheduler   = "aw-scheduler"
  }
  service_account_emails = merge({ for slot, name in local.runtime_accounts : slot => "${name}@${var.project_id}.iam.gserviceaccount.com" }, var.enable_bigquery_analytics ? { analytics = "aw-analytics@${var.project_id}.iam.gserviceaccount.com" } : {}, var.enable_agent ? { agent = "aw-agent@${var.project_id}.iam.gserviceaccount.com" } : {})
}
resource "google_service_account" "runtime" {
  for_each     = local.runtime_accounts
  project      = var.project_id
  account_id   = each.value
  display_name = each.value
}
resource "google_service_account" "analytics" {
  count      = var.enable_bigquery_analytics ? 1 : 0
  project    = var.project_id
  account_id = "aw-analytics"
}
resource "google_service_account" "agent" {
  count      = var.enable_agent ? 1 : 0
  project    = var.project_id
  account_id = "aw-agent"
}

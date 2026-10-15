mock_provider "google" {}
variables {
  project_id    = "aw-test-project"
  network       = "projects/aw-test-project/global/networks/aw-dev"
  client_emails = ["aw-api@aw-test-project.iam.gserviceaccount.com"]
}
run "approved_interface" {
  command = plan
  assert {
    condition     = !google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled && google_sql_database_instance.postgres.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "Private-only encrypted Postgres."
  }
  assert {
    condition     = google_sql_user.client["aw-api@aw-test-project.iam.gserviceaccount.com"].type == "CLOUD_IAM_SERVICE_ACCOUNT"
    error_message = "IAM DB user, no password."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    client_emails = ["human@example.test"]
  }
  expect_failures = [var.client_emails]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

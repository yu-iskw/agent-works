mock_provider "google" {}
variables {
  project_id = "aw-test-project"
  secrets    = { "oauth-client-secret" = { accessor_emails = ["aw-tool-broker@aw-test-project.iam.gserviceaccount.com"] } }
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_secret_manager_secret.container["oauth-client-secret"].replication[0].user_managed[0].replicas[0].location == "asia-northeast1"
    error_message = "Regional secret replication."
  }
  assert {
    condition     = alltrue([for binding in values(output.iam_bindings) : binding.role == "roles/secretmanager.secretAccessor"])
    error_message = "No version-writer grant by default."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    secrets = { "oauth-client-secret" = { accessor_emails = ["human@example.test"] } }
  }
  expect_failures = [var.secrets]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

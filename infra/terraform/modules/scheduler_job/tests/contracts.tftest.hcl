mock_provider "google" {}
variables {
  project_id                    = "aw-test-project"
  target                        = "https://example.invalid/execute"
  invoker_service_account_email = "aw-scheduler@aw-test-project.iam.gserviceaccount.com"
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_cloud_scheduler_job.job.http_target[0].oidc_token[0].service_account_email == var.invoker_service_account_email
    error_message = "Existing OIDC identity only."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    invoker_service_account_email = "human@example.test"
  }
  expect_failures = [var.invoker_service_account_email]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

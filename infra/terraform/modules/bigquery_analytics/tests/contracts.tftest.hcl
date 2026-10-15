mock_provider "google" {}
variables {
  project_id      = "aw-test-project"
  datasets        = ["approved"]
  reader_emails   = ["aw-analytics@aw-test-project.iam.gserviceaccount.com"]
  job_user_emails = ["aw-analytics@aw-test-project.iam.gserviceaccount.com"]
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_bigquery_dataset.approved["approved"].location == "asia-northeast1"
    error_message = "Regional approved dataset."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    reader_emails = ["human@example.test"]
  }
  expect_failures = [var.reader_emails]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

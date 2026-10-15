mock_provider "google" {}
variables {
  project_id                 = "aw-test-project"
  encrypter_decrypter_emails = ["aw-api@aw-test-project.iam.gserviceaccount.com"]
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_kms_key_ring.governance.location == "asia-northeast1" && google_kms_crypto_key.governance.rotation_period == "7776000s"
    error_message = "Regional rotated governance key."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    encrypter_decrypter_emails = ["human@example.test"]
  }
  expect_failures = [var.encrypter_decrypter_emails]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

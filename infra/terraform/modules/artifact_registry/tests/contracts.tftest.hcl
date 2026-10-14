mock_provider "google" {}
variables {
  project_id    = "aw-test-project"
  writer_emails = ["aw-deployer@aw-test-project.iam.gserviceaccount.com"]
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_artifact_registry_repository.images.docker_config[0].immutable_tags
    error_message = "Immutable images."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    writer_emails = ["human@example.test"]
  }
  expect_failures = [var.writer_emails]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

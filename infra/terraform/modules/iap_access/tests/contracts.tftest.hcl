mock_provider "google" {}
variables {
  project_id   = "aw-test-project"
  service_name = "aw-web"
  members      = ["user:alice@example.test"]
}
run "approved_interface" {
  command = plan
  assert {
    condition     = output.members == toset(["user:alice@example.test"])
    error_message = "Only approved users."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    members = ["allUsers"]
  }
  expect_failures = [var.members]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

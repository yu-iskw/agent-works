mock_provider "google" {}
variables {
  project_id         = "aw-test-project"
  billing_account_id = "ABCDEF-ABCDEF-ABCDEF"
  project_number     = "123456789012"
}
run "approved_interface" {
  command = plan
  assert {
    condition     = length(output.thresholds) == 4 && length(output.pubsub_topics) == 0
    error_message = "Alerts only, including above reference amount."
  }
}

mock_provider "google" {}
variables {
  project_id = "aw-test-project"

}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository == '${var.repository}' && (${var.attribute_condition})"
    error_message = "Repository condition retained."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.access"] == "assertion.event_name == 'pull_request' || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main') ? 'plan' : ('environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' ? 'dev' : 'denied')"
    error_message = "Plan and environment federation remain separate."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    repository = "outsider/repo"
  }
  expect_failures = [var.repository]
}

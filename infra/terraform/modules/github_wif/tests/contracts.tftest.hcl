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
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.job_workflow_ref"] == "assertion.job_workflow_ref"
    error_message = "job_workflow_ref must be mapped for workflow-file pinning."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.access"] == "'environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/deploy-dev.yml@refs/heads/main' ? 'dev' : (((assertion.event_name == 'pull_request' && assertion.job_workflow_ref.startsWith('yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/pull/')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/heads/main')) ? 'plan' : 'denied')"
    error_message = "Deploy on main (including workflow_dispatch) maps to dev via deploy-dev.yml; plan is pinned to infra-plan.yml."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.access"], "assertion.job_workflow_ref.startsWith('yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/pull/')") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.access"], "infra-plan.yml@refs/heads/main' && (assertion.event_name == 'pull_request'")
    error_message = "Pull-request plan tokens carry job_workflow_ref @refs/pull/N/merge: the access mapping must match them by prefix, not by the main ref."
  }
  assert {
    condition     = var.attribute_condition == "assertion.repository == 'yu-iskw/agent-works' && (('environment' in assertion && assertion.environment == 'dev' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/deploy-dev.yml@refs/heads/main') || ((assertion.event_name == 'pull_request' && assertion.job_workflow_ref.startsWith('yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/pull/')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == 'yu-iskw/agent-works/.github/workflows/infra-plan.yml@refs/heads/main')))"
    error_message = "Default attribute_condition must pin repository and workflow refs on refs/heads/main."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    repository = "outsider/repo"
  }
  expect_failures = [var.repository]
}

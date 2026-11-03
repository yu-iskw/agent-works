mock_provider "google" {}
variables {
  project_id                    = "aw-test-project"
  project_number                = "123456789012"
  api_service_account_email     = "aw-api@aw-test-project.iam.gserviceaccount.com"
  deployer_email                = "aw-deployer@aw-test-project.iam.gserviceaccount.com"
  caller_service_account_emails = ["aw-scheduler@aw-test-project.iam.gserviceaccount.com"]
  artifact_bucket_name          = "aw-test-project-artifacts"
}
run "approved_interface" {
  command = plan
  assert {
    condition     = output.required_ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" && output.oidc_audience == "https://aw-worker-123456789012.asia-northeast1.run.app"
    error_message = "Worker is internal-only with a deterministic audience."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.caller["aw-scheduler@aw-test-project.iam.gserviceaccount.com"].role == "roles/run.invoker" && length(google_cloud_run_v2_service_iam_member.caller) == 1
    error_message = "Only the listed caller is an invoker."
  }
  assert {
    condition     = google_storage_bucket.artifacts.public_access_prevention == "enforced" && google_storage_bucket.artifacts.uniform_bucket_level_access
    error_message = "Artifact bucket is private."
  }
}
run "reject_api_as_worker_caller" {
  command = plan
  variables {
    caller_service_account_emails = ["aw-api@aw-test-project.iam.gserviceaccount.com"]
  }
  expect_failures = [var.caller_service_account_emails]
}
run "reject_non_service_account_caller" {
  command = plan
  variables {
    caller_service_account_emails = ["alice@example.com"]
  }
  expect_failures = [var.caller_service_account_emails]
}
run "reject_empty_callers" {
  command = plan
  variables {
    caller_service_account_emails = []
  }
  expect_failures = [var.caller_service_account_emails]
}
run "reject_admin_project_role" {
  command = plan
  variables {
    project_roles = ["roles/run.admin"]
  }
  expect_failures = [var.project_roles]
}
run "reject_worker_equal_to_api" {
  command = plan
  variables {
    account_id = "aw-api"
  }
  expect_failures = [google_service_account.worker]
}

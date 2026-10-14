mock_provider "google" {}
variables {
  project_id = "aw-test-project"
  grants     = { api = { member = "serviceAccount:aw-api@aw-test-project.iam.gserviceaccount.com", roles = ["roles/logging.logWriter"] } }
}
run "approved_interface" {
  command = plan
  assert {
    condition     = length(output.iam_bindings) == 1
    error_message = "Additive member grant only."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    grants = { api = { member = "user:human@example.test", roles = ["roles/logging.logWriter"] } }
  }
  expect_failures = [var.grants]
}
run "reject_basic_owner" {
  command = plan
  variables {
    grants = { api = { member = "serviceAccount:aw-api@aw-test-project.iam.gserviceaccount.com", roles = ["roles/owner"] } }
  }
  expect_failures = [var.grants]
}
run "reject_basic_editor" {
  command = plan
  variables {
    grants = { api = { member = "serviceAccount:aw-api@aw-test-project.iam.gserviceaccount.com", roles = ["roles/editor"] } }
  }
  expect_failures = [var.grants]
}

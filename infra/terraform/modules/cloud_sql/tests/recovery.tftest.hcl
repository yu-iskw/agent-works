mock_provider "google" {}
variables {
  project_id    = "aw-test-project"
  network       = "projects/aw-test-project/global/networks/aw-dev"
  client_emails = ["aw-api@aw-test-project.iam.gserviceaccount.com"]
}
run "ha_pitr_backup_defaults" {
  command = plan
  assert {
    condition     = google_sql_database_instance.postgres.settings[0].availability_type == "REGIONAL"
    error_message = "HA is regional by default."
  }
  assert {
    condition     = google_sql_database_instance.postgres.settings[0].backup_configuration[0].point_in_time_recovery_enabled && google_sql_database_instance.postgres.settings[0].backup_configuration[0].transaction_log_retention_days == 7
    error_message = "PITR is on with 7 days of logs."
  }
  assert {
    condition     = google_sql_database_instance.postgres.deletion_protection
    error_message = "Deletion protection stays on."
  }
}
run "explicit_max_connections_flag" {
  command = plan
  variables {
    max_connections = 200
  }
  assert {
    condition     = length([for f in google_sql_database_instance.postgres.settings[0].database_flags : f if f.name == "max_connections" && f.value == "200"]) == 1
    error_message = "max_connections flag is set exactly once."
  }
}
run "no_max_connections_flag_by_default" {
  command = plan
  assert {
    condition     = length([for f in google_sql_database_instance.postgres.settings[0].database_flags : f if f.name == "max_connections"]) == 0
    error_message = "Tier default applies unless set."
  }
}
run "reject_bad_availability" {
  command = plan
  variables {
    availability_type = "MULTI"
  }
  expect_failures = [var.availability_type]
}
run "reject_bad_backup_time" {
  command = plan
  variables {
    backup_start_time = "25:99"
  }
  expect_failures = [var.backup_start_time]
}
run "reject_zero_retained_backups" {
  command = plan
  variables {
    retained_backups = 0
  }
  expect_failures = [var.retained_backups]
}

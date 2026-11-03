resource "google_cloud_tasks_queue" "queue" {
  project  = var.project_id
  location = var.region
  name     = var.name

  retry_config {
    max_attempts       = var.max_attempts
    min_backoff        = "${var.min_backoff_seconds}s"
    max_backoff        = "${var.max_backoff_seconds}s"
    max_doublings      = var.max_doublings
    max_retry_duration = "${var.max_retry_duration_seconds}s"
  }

  rate_limits {
    max_dispatches_per_second = var.max_dispatches_per_second
    max_concurrent_dispatches = var.max_concurrent_dispatches
  }
}

resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.queue.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${var.dispatcher_service_account_email}"
}

# Enqueuing a task that carries an OIDC token requires actAs on the token identity.
resource "google_service_account_iam_member" "oidc_act_as" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.dispatcher_service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.dispatcher_service_account_email}"
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = var.worker_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.dispatcher_service_account_email}"
}

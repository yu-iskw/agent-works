output "queue_id" {
  description = "Reviewable queue id."
  value       = google_cloud_tasks_queue.queue.id
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value = {
    enqueuer = { member = google_cloud_tasks_queue_iam_member.enqueuer.member, role = google_cloud_tasks_queue_iam_member.enqueuer.role, scope = var.name }
    act_as   = { member = google_service_account_iam_member.oidc_act_as.member, role = google_service_account_iam_member.oidc_act_as.role, scope = var.dispatcher_service_account_email }
    invoker  = { member = google_cloud_run_v2_service_iam_member.invoker.member, role = google_cloud_run_v2_service_iam_member.invoker.role, scope = var.worker_service_name }
  }
}

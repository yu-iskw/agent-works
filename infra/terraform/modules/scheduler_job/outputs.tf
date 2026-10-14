output "job_id" {
  description = "Reviewable job id."
  value       = google_cloud_scheduler_job.job.id
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

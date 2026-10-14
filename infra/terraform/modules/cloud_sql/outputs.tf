output "connection_name" {
  description = "Reviewable connection name."
  value       = google_sql_database_instance.postgres.connection_name
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

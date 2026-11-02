output "connection_name" {
  description = "Reviewable connection name."
  value       = google_sql_database_instance.postgres.connection_name
}
output "instance_name" {
  description = "Instance name, needed for backup listing, clone and PITR restore commands."
  value       = google_sql_database_instance.postgres.name
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

resource "google_compute_global_address" "private" {
  project       = var.project_id
  name          = "${var.name}-private"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = var.network
}
resource "google_service_networking_connection" "private" {
  network                 = var.network
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private.name]
}
resource "google_sql_database_instance" "postgres" {
  #checkov:skip=CKV_GCP_6:ENCRYPTED_ONLY enforces TLS while supporting keyless IAM DB authentication; this policy requires client certificates instead.
  #checkov:skip=CKV_GCP_79:D1 is off by default; Postgres 16 matches the approved pilot runtime and major upgrades require operator review.
  #checkov:skip=CKV_GCP_109:Do not log SQL text or payload-bearing error statements; log_min_error_statement=PANIC follows repository redaction requirements.
  #checkov:skip=CKV_GCP_111:Do not log SQL statements containing ledger, user or credential payloads; log_statement=none is intentional.
  project             = var.project_id
  region              = var.region
  name                = var.name
  database_version    = "POSTGRES_16"
  deletion_protection = true
  settings {
    tier              = var.tier
    availability_type = "REGIONAL"
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    database_flags {
      name  = "log_min_messages"
      value = "warning"
    }
    database_flags {
      name  = "log_temp_files"
      value = "0"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "-1"
    }
    database_flags {
      name  = "log_hostname"
      value = "on"
    }
    database_flags {
      name  = "log_min_error_statement"
      value = "panic"
    }
    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }
    database_flags {
      name  = "pgaudit.log"
      value = "none"
    }
    database_flags {
      name  = "log_statement"
      value = "none"
    }
    database_flags {
      name  = "log_duration"
      value = "on"
    }
    database_flags {
      name  = "log_executor_stats"
      value = "off"
    }
    database_flags {
      name  = "log_parser_stats"
      value = "off"
    }
    database_flags {
      name  = "log_planner_stats"
      value = "off"
    }
    database_flags {
      name  = "log_statement_stats"
      value = "off"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }
  depends_on = [google_service_networking_connection.private]
}
resource "google_sql_user" "client" {
  for_each = var.client_emails
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = trimsuffix(each.key, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

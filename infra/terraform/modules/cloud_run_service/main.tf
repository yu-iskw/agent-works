resource "google_cloud_run_v2_service" "service" {
  project             = var.project_id
  location            = var.region
  name                = var.name
  ingress             = var.ingress
  iap_enabled         = var.iap_enabled
  deletion_protection = true
  template {
    service_account = var.service_account_email
    containers {
      image = var.image
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = env.value.version
            }
          }
        }
      }
    }
    dynamic "vpc_access" {
      for_each = var.network == null ? [] : [var.network]
      content {
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = vpc_access.value.network
          subnetwork = vpc_access.value.subnetwork
        }
      }
    }
  }
}
locals {
  invokers = setunion(var.invoker_members, var.iap_enabled ? toset(["serviceAccount:${var.iap_service_agent_email}"]) : toset([]))
}
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = local.invokers
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = each.key
}
resource "google_cloud_run_v2_service_iam_member" "deployer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${var.deployer_email}"
}

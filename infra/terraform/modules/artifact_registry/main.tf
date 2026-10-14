resource "google_artifact_registry_repository" "images" {
  #checkov:skip=CKV_GCP_84:Approved design uses Google-managed encryption; optional governance KMS is not a repository key.
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  docker_config { immutable_tags = true }
}
locals {
  bindings = merge({ for email in var.writer_emails : "writer/${email}" => { email = email, role = "roles/artifactregistry.writer" }
    }, { for email in var.reader_emails : "reader/${email}" => { email = email, role = "roles/artifactregistry.reader" }
  })
}
resource "google_artifact_registry_repository_iam_member" "grant" {
  for_each   = local.bindings
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  member     = "serviceAccount:${each.value.email}"
  role       = each.value.role
}

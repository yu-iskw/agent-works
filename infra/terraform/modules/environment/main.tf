resource "google_project" "this" {
  name                = var.project_id
  project_id          = var.project_id
  folder_id           = var.folder_id
  billing_account     = var.billing_account_id
  auto_create_network = false
  deletion_policy     = "PREVENT"
}

resource "google_project_service" "control_plane" {
  for_each = local.control_plane_apis

  project            = google_project.this.project_id
  service            = each.key
  disable_on_destroy = false
}

locals {
  grants = merge({}, flatten([
    for slot, identity in var.identities : [
      for capability in identity.grants : {
        for role in local.capabilities[local.slots[slot]][capability] :
        "${slot}/${role}" => { slot = slot, role = role }
      }
    ]
  ])...)
}

resource "google_service_account" "this" {
  for_each = var.identities

  project      = google_project.this.project_id
  account_id   = each.value.account_id
  display_name = "${each.key} (${local.slots[each.key]})"

  depends_on = [google_project_service.control_plane]
}

resource "google_project_iam_member" "grant" {
  for_each = local.grants

  project = google_project.this.project_id
  role    = each.value.role
  member  = google_service_account.this[each.value.slot].member
}

# The deployer may act as each runtime identity and nothing wider. Scoped to
# the service account, never the project, so it cannot act as itself or as a
# default account.
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = toset(local.runtime_slots)

  service_account_id = google_service_account.this[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.this["deployer"].member
}

# Bootstrap alone manages custom roles. Project scope permits creation; runtime
# data access and IAM/custom-role administration are deliberately excluded.
# Private SQL peering also needs global address INTERNAL permissions:
# https://docs.cloud.google.com/sql/docs/postgres/configure-private-services-access
locals {
  provisioning_permissions = {
    network = [
      "compute.networks.create",
      "compute.networks.delete",
      "compute.networks.get",
      "compute.networks.update",
      "compute.networks.updatePolicy",
      "compute.networks.use",
      "compute.subnetworks.create",
      "compute.subnetworks.delete",
      "compute.subnetworks.get",
      "compute.subnetworks.update",
      "compute.subnetworks.use",
      "compute.regionOperations.get",
      "compute.globalOperations.get",
    ]
    nat = [
      "compute.routers.create",
      "compute.routers.delete",
      "compute.routers.get",
      "compute.routers.update",
      "compute.networks.use",
      "compute.subnetworks.get",
      "compute.subnetworks.use",
      "compute.regionOperations.get",
    ]
    cloud_sql = [
      "cloudsql.instances.create",
      "cloudsql.instances.delete",
      "cloudsql.instances.get",
      "cloudsql.instances.update",
      "cloudsql.users.create",
      "cloudsql.users.delete",
      "cloudsql.users.list",
      "cloudsql.users.update",
      "compute.globalAddresses.create",
      "compute.globalAddresses.createInternal",
      "compute.globalAddresses.delete",
      "compute.globalAddresses.deleteInternal",
      "compute.globalAddresses.get",
      "compute.globalAddresses.list",
      "compute.globalAddresses.use",
      "compute.networks.get",
      "compute.networks.use",
      "compute.networks.addPeering",
      "compute.networks.removePeering",
      "compute.networks.updatePeering",
      "compute.globalOperations.get",
      "servicenetworking.services.addPeering",
      "servicenetworking.services.get",
      "servicenetworking.services.use",
      "servicenetworking.services.deleteConnection",
      "servicenetworking.operations.get",
    ]
    kms = [
      "cloudkms.keyRings.create",
      "cloudkms.keyRings.get",
      "cloudkms.cryptoKeys.create",
      "cloudkms.cryptoKeys.get",
      "cloudkms.cryptoKeys.update",
      "cloudkms.cryptoKeys.getIamPolicy",
      "cloudkms.cryptoKeys.setIamPolicy",
    ]
    bigquery_analytics = [
      "bigquery.datasets.create",
      "bigquery.datasets.get",
      "bigquery.datasets.update",
      "bigquery.datasets.delete",
      "bigquery.datasets.getIamPolicy",
      "bigquery.datasets.setIamPolicy",
    ]
  }
  provisioning_enabled = {
    network            = var.enable_network
    nat                = var.enable_network && var.enable_nat
    cloud_sql          = var.enable_cloud_sql
    kms                = var.enable_kms
    bigquery_analytics = var.enable_bigquery_analytics
  }
}
resource "google_project_iam_custom_role" "provisioning" {
  for_each    = { for name, permissions in local.provisioning_permissions : name => permissions if local.provisioning_enabled[name] }
  project     = google_project.dev.project_id
  role_id     = "aw_tf_${each.key}"
  title       = "Terraform ${each.key} provisioning"
  permissions = each.value
  depends_on  = [module.baseline]
}
resource "google_project_iam_member" "provisioning" {
  for_each   = google_project_iam_custom_role.provisioning
  project    = google_project.dev.project_id
  role       = each.value.name
  member     = "serviceAccount:${local.terraform_emails["aw-tf-dev"]}"
  depends_on = [google_service_account.terraform]
}
resource "google_project_iam_custom_role" "workflow_adapter" {
  count       = var.enable_workflows ? 1 : 0
  project     = google_project.dev.project_id
  role_id     = "pilot_durable_tasks_adapter"
  title       = "Pilot workflow dispatcher and callback sender"
  permissions = ["workflows.executions.create", "workflows.executions.list", "workflows.executions.cancel", "workflows.callbacks.list", "workflows.callbacks.send"]
  depends_on  = [module.baseline]
}

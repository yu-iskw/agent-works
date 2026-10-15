data "terraform_remote_state" "identity" {
  count   = var.service_account_emails == null ? 1 : 0
  backend = "gcs"
  config = {
    bucket                      = var.state_bucket
    prefix                      = "identity/dev"
    impersonate_service_account = var.terraform_service_account
  }
}
locals {
  # Keep configuration ownership stable when read-only CI runs as aw-tf-plan.
  dev_applier_email = "aw-tf-dev@${var.project_id}.iam.gserviceaccount.com"
  sa                = var.service_account_emails != null ? var.service_account_emails : data.terraform_remote_state.identity[0].outputs.service_account_emails
  base_apis = toset([
    "billingbudgets.googleapis.com", "cloudresourcemanager.googleapis.com", "iam.googleapis.com", "orgpolicy.googleapis.com", "serviceusage.googleapis.com",
    "iamcredentials.googleapis.com", "sts.googleapis.com", "storage.googleapis.com",
    "run.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "iap.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "cloudtrace.googleapis.com",
    "aiplatform.googleapis.com", "drive.googleapis.com", "docs.googleapis.com", "gmail.googleapis.com", "calendar-json.googleapis.com",
  ])
  apis = setunion(local.base_apis,
    var.enable_workflows ? toset(["workflows.googleapis.com", "workflowexecutions.googleapis.com"]) : toset([]),
    var.enable_scheduler ? toset(["cloudscheduler.googleapis.com"]) : toset([]),
    var.enable_kms ? toset(["cloudkms.googleapis.com"]) : toset([]),
    var.enable_cloud_sql ? toset(["sqladmin.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com"]) : toset([]),
    var.enable_network ? toset(["compute.googleapis.com"]) : toset([]),
  var.enable_bigquery_analytics ? toset(["bigquery.googleapis.com"]) : toset([]))
  observability = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent"])
}
module "baseline" {
  source     = "../../modules/project_baseline"
  project_id = var.project_id
  apis       = local.apis
  # Audit config is opt-in for adopted projects.
  enable_audit_config = var.enable_audit_config
  # Guards and default-SA deprivilege belong exclusively to bootstrap (D5).
}
module "budget" {
  count              = var.enable_budget ? 1 : 0
  source             = "../../modules/budget"
  project_id         = var.project_id
  project_number     = var.project_number
  billing_account_id = var.billing_account_id
  depends_on         = [module.baseline]
}
module "project_iam" {
  source     = "../../modules/project_iam"
  project_id = var.project_id
  grants = merge({ for slot in ["web", "api", "tool_broker"] : slot => { member = "serviceAccount:${local.sa[slot]}", roles = setunion(local.observability, slot == "api" ? toset(["roles/aiplatform.user"]) : toset([]), slot == "api" && var.enable_cloud_sql ? toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser"]) : toset([])) }
    }, { workflow = { member = "serviceAccount:${local.sa.workflow}", roles = ["roles/logging.logWriter"] }
  })
  depends_on = [module.baseline]
}
module "artifact_registry" {
  source        = "../../modules/artifact_registry"
  project_id    = var.project_id
  writer_emails = [local.sa.deployer]
  depends_on    = [module.baseline]
}
module "secrets" {
  source     = "../../modules/secrets"
  project_id = var.project_id
  secrets = {
    "oauth-client-secret" = { accessor_emails = [local.sa.tool_broker] }
    "drive-worker-token"  = { accessor_emails = [local.sa.tool_broker] }
  }
  depends_on = [module.baseline]
}
module "web" {
  count                   = contains(keys(var.images), "web") ? 1 : 0
  source                  = "../../modules/cloud_run_service"
  project_id              = var.project_id
  name                    = "aw-web"
  image                   = var.images.web
  service_account_email   = local.sa.web
  deployer_email          = local.sa.deployer
  iap_service_agent_email = "service-${var.project_number}@gcp-sa-iap.iam.gserviceaccount.com"
  env                     = lookup(var.service_env, "web", {})
  secret_env              = lookup(var.service_secret_env, "web", {})
  network                 = var.enable_network ? module.network[0].direct_vpc_egress : null
  depends_on              = [module.baseline, module.secrets, module.artifact_registry]
}
module "api" {
  count                 = contains(keys(var.images), "api") ? 1 : 0
  source                = "../../modules/cloud_run_service"
  project_id            = var.project_id
  name                  = "aw-api"
  image                 = var.images.api
  service_account_email = local.sa.api
  deployer_email        = local.sa.deployer
  iap_enabled           = false
  ingress               = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_members       = ["serviceAccount:${local.sa.web}", "serviceAccount:${local.sa.scheduler}"]
  env                   = lookup(var.service_env, "api", {})
  secret_env            = lookup(var.service_secret_env, "api", {})
  network               = var.enable_network ? module.network[0].direct_vpc_egress : null
  depends_on            = [module.baseline, module.secrets, module.artifact_registry]
}
module "tool_broker" {
  count                 = contains(keys(var.images), "tool_broker") ? 1 : 0
  source                = "../../modules/cloud_run_service"
  project_id            = var.project_id
  name                  = "aw-tool-broker"
  image                 = var.images.tool_broker
  service_account_email = local.sa.tool_broker
  # The runtime broker is managed by the Terraform applier, not the web/API deployer.
  deployer_email  = local.dev_applier_email
  iap_enabled     = false
  ingress         = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_members = var.enable_workflows ? [] : ["serviceAccount:${local.sa.workflow}"]
  env             = lookup(var.service_env, "tool_broker", {})
  secret_env      = lookup(var.service_secret_env, "tool_broker", {})
  network         = var.enable_network ? module.network[0].direct_vpc_egress : null
  depends_on      = [module.baseline, module.secrets, module.artifact_registry]
}
module "iap_access" {
  count        = length(module.web)
  source       = "../../modules/iap_access"
  project_id   = var.project_id
  service_name = module.web[0].name
  members      = var.iap_members
}
module "network" {
  count      = var.enable_network ? 1 : 0
  source     = "../../modules/network"
  project_id = var.project_id
  enable_nat = var.enable_nat
  depends_on = [module.baseline]
}
module "kms" {
  count                      = var.enable_kms ? 1 : 0
  source                     = "../../modules/kms"
  project_id                 = var.project_id
  encrypter_decrypter_emails = [local.sa.api]
  depends_on                 = [module.baseline]
}
module "cloud_sql" {
  count         = var.enable_cloud_sql ? 1 : 0
  source        = "../../modules/cloud_sql"
  project_id    = var.project_id
  network       = var.enable_network ? module.network[0].network : null
  client_emails = [local.sa.api]
  depends_on    = [module.baseline]
}
module "bigquery_analytics" {
  count           = var.enable_bigquery_analytics ? 1 : 0
  source          = "../../modules/bigquery_analytics"
  project_id      = var.project_id
  datasets        = var.approved_datasets
  reader_emails   = [local.sa.analytics]
  job_user_emails = [local.sa.analytics]
  depends_on      = [module.baseline]
}
module "scheduler_job" {
  count                         = var.enable_scheduler ? 1 : 0
  source                        = "../../modules/scheduler_job"
  project_id                    = var.project_id
  target                        = var.scheduler_target
  invoker_service_account_email = local.sa.scheduler
  depends_on                    = [module.baseline]
}

locals {
  slots = {
    bff                 = "runtime"
    task_service        = "runtime"
    tool_broker         = "runtime"
    scheduled_execution = "runtime"
    deployer            = "deployer"
  }

  capabilities = {
    runtime = {
      observability = [
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter",
        "roles/cloudtrace.agent",
      ]
    }
    deployer = {
      run_deploy = [
        "roles/run.developer",
        "roles/artifactregistry.writer",
      ]
    }
  }

  control_plane_apis = toset([
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "orgpolicy.googleapis.com",
    "serviceusage.googleapis.com",
  ])

  runtime_slots = [for slot, kind in local.slots : slot if kind == "runtime"]
}

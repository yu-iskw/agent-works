locals {
  # The identity slots and the kind of each. The registry must name exactly
  # these keys. Adding an identity is an edit here, reviewed with its test.
  slots = {
    bff                 = "runtime"
    task_service        = "runtime"
    tool_broker         = "runtime"
    scheduled_execution = "runtime"
    deployer            = "deployer"
  }

  # The only role ids this module can bind. The registry names a capability
  # and never a role, so a role outside this table cannot be written by a
  # caller. A runtime identity cannot hold a deployer capability and the
  # reverse. Invariant: no basic role (owner, editor) and no role that can
  # mint or impersonate credentials appears in any value below.
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

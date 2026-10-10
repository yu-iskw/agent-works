# environments/dev/tests/dev.tftest.hcl is a symlink to this file.
# terraform test only looks beside the root module, and the required path is this file.
# A run label cannot contain a dot, so infra-no-owner-binding is the id infra.no-owner-binding.
# infra/terraform/evidence.mjs reads that status.

mock_provider "google" {}

variables {
  project_id         = "pilot-dev-check"
  folder_id          = "100000000001"
  billing_account_id = "ABCDEF-ABCDEF-ABCDEF"
}

run "identities-are-separate" {
  command = plan

  assert {
    condition     = toset(keys(module.dev.service_accounts)) == toset(["bff", "task_service", "tool_broker", "scheduled_execution", "deployer"])
    error_message = "RFC-001 14.1 needs identities for the BFF, task service, tool broker, scheduled execution, and deployment."
  }

  assert {
    condition     = length(distinct([for sa in values(module.dev.service_accounts) : sa.account_id])) == 5
    error_message = "Every identity needs its own service account."
  }

  assert {
    condition = length(setintersection(
      toset([for b in values(module.dev.iam_bindings) : b.role if b.slot == "deployer" && b.scope == "project"]),
      toset([for b in values(module.dev.iam_bindings) : b.role if b.slot != "deployer"]),
    )) == 0
    error_message = "A runtime identity holds a role the deployer holds."
  }
}

run "bindings-are-the-literal-set" {
  command = plan

  # Values carry slot, scope, and role. The runtime slot is only in the key.
  assert {
    condition = toset([
      for b in values(module.dev.iam_bindings) : "${b.slot}|${b.scope}|${b.role}"
      ]) == toset([
      "bff|project|roles/cloudtrace.agent",
      "bff|project|roles/logging.logWriter",
      "bff|project|roles/monitoring.metricWriter",
      "deployer|project|roles/artifactregistry.writer",
      "deployer|project|roles/run.developer",
      "deployer|service_account|roles/iam.serviceAccountUser",
      "scheduled_execution|project|roles/cloudtrace.agent",
      "scheduled_execution|project|roles/logging.logWriter",
      "scheduled_execution|project|roles/monitoring.metricWriter",
      "task_service|project|roles/cloudtrace.agent",
      "task_service|project|roles/logging.logWriter",
      "task_service|project|roles/monitoring.metricWriter",
      "tool_broker|project|roles/cloudtrace.agent",
      "tool_broker|project|roles/logging.logWriter",
      "tool_broker|project|roles/monitoring.metricWriter",
    ])
    error_message = "The planned binding set is not the literal slot|scope|role set."
  }

  assert {
    condition = toset([
      for key, b in module.dev.iam_bindings : key
      if b.slot == "deployer" && b.scope == "service_account" && b.role == "roles/iam.serviceAccountUser"
      ]) == toset([
      "deployer/bff/roles/iam.serviceAccountUser",
      "deployer/scheduled_execution/roles/iam.serviceAccountUser",
      "deployer/task_service/roles/iam.serviceAccountUser",
      "deployer/tool_broker/roles/iam.serviceAccountUser",
    ])
    error_message = "Each runtime slot needs one deployer roles/iam.serviceAccountUser binding."
  }
}

run "infra-no-owner-binding" {
  command = plan

  assert {
    condition     = alltrue([for b in values(module.dev.iam_bindings) : !contains(["roles/owner", "roles/editor"], b.role)])
    error_message = "The plan binds a basic owner or editor role."
  }

  assert {
    condition = length(regexall("roles/(owner|editor)\\b", join("\n", concat(
      [for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")],
      [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")],
    )))) == 0
    error_message = "A .tf file under environments/dev or modules names a basic owner or editor role."
  }
}

run "infra-no-sa-keys" {
  command = plan

  assert {
    condition = length(regexall("google_service_account_key", join("\n", concat(
      [for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")],
      [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")],
    )))) == 0
    error_message = "A .tf file under environments/dev or modules declares a service account key."
  }

  assert {
    condition = alltrue([
      for key in ["iam.disableServiceAccountKeyCreation", "iam.disableServiceAccountKeyUpload"] :
      lookup(module.dev.org_policies, key, "FALSE") == "TRUE"
    ])
    error_message = "The project does not forbid creating or uploading service account keys."
  }
}

run "scan-is-complete" {
  command = plan

  assert {
    condition     = length(fileset(path.root, "*.tf.json")) + length(fileset("${path.root}/../../modules", "**/*.tf.json")) == 0
    error_message = "JSON-syntax configuration is not scanned by infra-no-owner-binding and infra-no-sa-keys."
  }

  assert {
    condition = alltrue([
      for m in regexall("(?m)^\\s*source\\s*=\\s*\"([^\"]+)\"", join("\n", concat(
        [for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")],
        [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")],
      ))) : can(regex("^(\\.\\.?/|hashicorp/google$)", m[0]))
    ])
    error_message = "A module source is not a local path. A remote module hides resources from the scan."
  }
}

run "root-only-calls-modules" {
  command = plan

  assert {
    condition     = length(regexall("(?m)^\\s*(resource|data)\\s+\"", join("\n", [for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")]))) == 0
    error_message = "environments/dev declares a resource or data source. Resources belong in a module."
  }
}

run "budget-alerts-only" {
  command = plan

  assert {
    condition     = length(module.dev.budget.thresholds) > 0
    error_message = "The budget has no alert thresholds."
  }

  assert {
    condition     = length(module.dev.budget.pubsub_topics) == 0
    error_message = "A Pub/Sub topic is wired to the budget. Automation could react to it and cap spend."
  }
}

run "owner-is-not-a-grant" {
  command = plan

  module {
    source = "../../modules/environment"
  }

  variables {
    identities = {
      bff                 = { account_id = "pilot-bff", grants = ["observability"] }
      task_service        = { account_id = "pilot-task-service", grants = ["observability"] }
      tool_broker         = { account_id = "pilot-tool-broker", grants = ["observability"] }
      scheduled_execution = { account_id = "pilot-scheduled-exec", grants = ["observability"] }
      deployer            = { account_id = "pilot-deployer", grants = ["roles/owner"] }
    }
    budget = {
      currency_code    = "USD"
      reference_amount = 100
      alert_at         = [1.0]
    }
  }

  expect_failures = [var.identities]
}

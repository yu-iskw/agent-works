mock_provider "google" {}
variables {
  project_id                = "aw-test-project"
  project_number            = "123456789012"
  billing_account_id        = "ABCDEF-ABCDEF-ABCDEF"
  terraform_service_account = "aw-tf-dev@aw-test-project.iam.gserviceaccount.com"
  service_account_emails    = { deployer = "aw-deployer@aw-test-project.iam.gserviceaccount.com", web = "aw-web@aw-test-project.iam.gserviceaccount.com", api = "aw-api@aw-test-project.iam.gserviceaccount.com", tool_broker = "aw-tool-broker@aw-test-project.iam.gserviceaccount.com", workflow = "aw-workflow@aw-test-project.iam.gserviceaccount.com", scheduler = "aw-scheduler@aw-test-project.iam.gserviceaccount.com" }
}
run "offline_foundations" {
  command = plan
  assert {
    condition     = length(data.terraform_remote_state.identity) == 0
    error_message = "Offline fallback must avoid GCS entirely."
  }
  assert {
    condition     = length(module.scheduler_job) + length(module.kms) + length(module.cloud_sql) + length(module.network) + length(module.bigquery_analytics) + length(module.workflows) == 0
    error_message = "All optional modules are off."
  }
  assert {
    condition     = output.enabled_apis == toset(["billingbudgets.googleapis.com", "cloudresourcemanager.googleapis.com", "iam.googleapis.com", "orgpolicy.googleapis.com", "serviceusage.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "iap.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "cloudtrace.googleapis.com", "aiplatform.googleapis.com", "drive.googleapis.com", "docs.googleapis.com", "gmail.googleapis.com", "calendar-json.googleapis.com"])
    error_message = "Default APIs must equal the exact D-list."
  }
  assert {
    condition     = length(module.budget.thresholds) == 4 && length(module.budget.pubsub_topics) == 0
    error_message = "Budget only alerts, never automates a shutdown."
  }
  assert {
    condition     = module.baseline.audit_log.service == "allServices" && module.baseline.audit_log.log_types == toset(["ADMIN_READ", "DATA_READ", "DATA_WRITE"])
    error_message = "All-services audit must survive the split."
  }
  assert {
    condition     = length(module.baseline.org_policies) == 0
    error_message = "Only bootstrap owns org-policy guards."
  }
  assert {
    condition     = alltrue([for binding in values(module.secrets.iam_bindings) : binding.role == "roles/secretmanager.secretAccessor" && binding.member == "serviceAccount:${local.sa.tool_broker}"]) && toset(keys(module.secrets.secret_ids)) == toset(["oauth-client-secret", "drive-worker-token"])
    error_message = "Only broker secrets and accessor grants by default."
  }
  assert {
    condition     = length(regexall("resource\\s+\"google_service_account\"", join("\n", concat([for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")], [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")])))) == 0
    error_message = "No workload or module identity resource may be planned."
  }
  assert {
    condition     = length(regexall("resource\\s+\"google_secret_manager_secret_version\"", join("\n", concat([for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")], [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")])))) == 0
    error_message = "Values and versions never enter Terraform."
  }
  assert {
    condition     = length(regexall("resource\\s+\"", join("\n", [for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")]))) == 0
    error_message = "Dev root resources belong in modules."
  }
}
run "infra-no-owner-binding" {
  command = plan
  assert {
    condition     = length(regexall("role\\s*=\\s*\"roles/(owner|editor)\"", join("\n", concat([for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")], [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")])))) == 0
    error_message = "No basic roles in workloads/modules."
  }
}
run "infra-no-sa-keys" {
  command = plan
  assert {
    condition     = length(regexall("google_service_account_key", join("\n", concat([for f in fileset(path.root, "*.tf") : file("${path.root}/${f}")], [for f in fileset("${path.root}/../../modules", "**/*.tf") : file("${path.root}/../../modules/${f}")])))) == 0
    error_message = "No credential resource declarations."
  }
}
run "runtime_bindings" {
  command = plan
  variables {
    enable_network = true
    images         = { web = "example.invalid/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", api = "example.invalid/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tool_broker = "example.invalid/broker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    iap_members    = ["user:alice@example.test", "user:bob@example.test", "group:reviewers@example.test"]
  }
  override_module {
    target = module.network[0]
    outputs = {
      network    = "projects/aw-test-project/global/networks/aw-dev"
      subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/aw-dev-direct"
      direct_vpc_egress = {
        network    = "projects/aw-test-project/global/networks/aw-dev"
        subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/aw-dev-direct"
      }
      iam_bindings = {}
    }
  }
  assert {
    condition     = module.web[0].vpc_access[0].egress == "ALL_TRAFFIC" && module.api[0].vpc_access[0].egress == "ALL_TRAFFIC" && module.web[0].vpc_access[0].network_interfaces[0].network == "projects/aw-test-project/global/networks/aw-dev" && module.web[0].vpc_access[0].network_interfaces[0].subnetwork == "projects/aw-test-project/regions/asia-northeast1/subnetworks/aw-dev-direct" && module.api[0].vpc_access[0].network_interfaces == module.web[0].vpc_access[0].network_interfaces
    error_message = "Web and API must share the supported Direct VPC path and route all traffic."
  }
  assert {
    condition     = toset([for binding in values(module.api[0].iam_bindings) : binding.member if binding.role == "roles/run.invoker"]) == toset(["serviceAccount:${local.sa.web}", "serviceAccount:${local.sa.scheduler}"])
    error_message = "API invokers must be exactly web and scheduler."
  }
  assert {
    condition     = module.iap_access[0].members == toset(["user:alice@example.test", "user:bob@example.test", "group:reviewers@example.test"]) && !contains(module.iap_access[0].members, "user:outsider@example.test")
    error_message = "IAP grants only the synthetic approved users/group."
  }
  assert {
    condition     = length(setintersection(toset([for binding in values(output.iam_bindings) : binding.role if binding.member == "serviceAccount:${local.sa.deployer}"]), toset([for binding in values(output.iam_bindings) : binding.role if contains(["serviceAccount:${local.sa.web}", "serviceAccount:${local.sa.api}", "serviceAccount:${local.sa.tool_broker}", "serviceAccount:${local.sa.workflow}", "serviceAccount:${local.sa.scheduler}"], binding.member)]))) == 0
    error_message = "Runtime roles must remain disjoint from deployer roles."
  }
  assert {
    condition     = module.web[0].name == "aw-web" && module.api[0].name == "aw-api"
    error_message = "Names must follow D2."
  }
}
run "workflow_opt_in" {
  command = plan
  variables {
    enable_workflows             = true
    workflow_broker_service_name = "aw-tool-broker"
    workflow_source_contents     = "main:\n  steps:\n    - done:\n        return: null\n"
  }
  assert {
    condition     = length(module.workflows) == 1 && module.workflows[0].adapter.service_account_email == local.sa.workflow
    error_message = "Workflow must use identity-root execution email."
  }
}
run "all_optional_flags" {
  command = plan
  variables {
    enable_network               = true
    enable_nat                   = true
    enable_cloud_sql             = true
    enable_kms                   = true
    enable_scheduler             = true
    enable_bigquery_analytics    = true
    enable_workflows             = true
    scheduler_target             = "https://example.invalid/execute"
    workflow_broker_service_name = "aw-tool-broker"
    workflow_source_contents     = "main:\n  steps:\n    - done:\n        return: null\n"
    approved_datasets            = ["approved"]
    service_account_emails = {
      deployer    = "aw-deployer@aw-test-project.iam.gserviceaccount.com"
      web         = "aw-web@aw-test-project.iam.gserviceaccount.com"
      api         = "aw-api@aw-test-project.iam.gserviceaccount.com"
      tool_broker = "aw-tool-broker@aw-test-project.iam.gserviceaccount.com"
      workflow    = "aw-workflow@aw-test-project.iam.gserviceaccount.com"
      scheduler   = "aw-scheduler@aw-test-project.iam.gserviceaccount.com"
      analytics   = "aw-analytics@aw-test-project.iam.gserviceaccount.com"
    }
  }
  override_module {
    target = module.network[0]
    outputs = {
      network    = "projects/aw-test-project/global/networks/aw-dev"
      subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/aw-dev-direct"
      direct_vpc_egress = {
        network    = "projects/aw-test-project/global/networks/aw-dev"
        subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/aw-dev-direct"
      }
      iam_bindings = {}
    }
  }
  assert {
    condition     = length(module.network) == 1 && length(module.cloud_sql) == 1 && length(module.kms) == 1 && length(module.scheduler_job) == 1 && length(module.bigquery_analytics) == 1 && length(module.workflows) == 1
    error_message = "Explicit opt-in must wire all optional modules."
  }
  assert {
    condition     = setsubtract(output.enabled_apis, local.base_apis) == toset(["compute.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com", "cloudkms.googleapis.com", "cloudscheduler.googleapis.com", "bigquery.googleapis.com", "workflows.googleapis.com", "workflowexecutions.googleapis.com"])
    error_message = "Optional APIs must be exactly the reviewed additions."
  }
}
run "read_only_executor_does_not_change_deployment_grants" {
  command = plan
  variables {
    terraform_service_account = "aw-tf-plan@aw-test-project.iam.gserviceaccount.com"
    images = {
      tool_broker = "example.invalid/broker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  assert {
    condition     = module.tool_broker[0].iam_bindings.deployer.member == "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com"
    error_message = "Plan CI must leave Terraform deployment grants on aw-tf-dev."
  }
  assert {
    condition     = alltrue([for binding in values(output.iam_bindings) : binding.member != "serviceAccount:aw-tf-plan@aw-test-project.iam.gserviceaccount.com"])
    error_message = "The read-only executor must gain no workload binding."
  }
}

run "reject_web_without_network" {
  command = plan
  variables {
    images = { web = "example.invalid/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
  expect_failures = [var.images]
}
run "reject_api_without_network" {
  command = plan
  variables {
    images = { api = "example.invalid/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
  expect_failures = [var.images]
}

mock_provider "google" {
  mock_data "google_project" {
    defaults = { project_id = "aw-test-project", number = "123456789012" }
  }
  mock_resource "google_project_iam_custom_role" {
    override_during = plan
    defaults        = { name = "projects/aw-test-project/roles/mock" }
  }
  mock_resource "google_service_account" {
    override_during = plan
    defaults = {
      name  = "projects/aw-test-project/serviceAccounts/aw-tf-mock@aw-test-project.iam.gserviceaccount.com"
      email = "aw-tf-mock@aw-test-project.iam.gserviceaccount.com"
    }
  }
}
variables {
  project_id        = "aw-test-project"
  operator_member   = "user:yu@example.test"
  breakglass_member = "group:aw-breakglass@example.test"
}
run "bootstrap_contract" {
  command = plan
  assert {
    condition     = toset(keys(google_service_account.terraform)) == toset(["aw-tf-identity", "aw-tf-dev", "aw-tf-plan"])
    error_message = "Bootstrap creates exactly three Terraform accounts."
  }
  assert {
    condition     = google_service_account.bootstrap_state.account_id == "aw-tf-bootstrap" && google_service_account.bootstrap_state.display_name == "aw-tf-bootstrap"
    error_message = "Bootstrap creates the aw-tf-bootstrap state maintenance account."
  }
  assert {
    condition     = google_service_account_iam_member.bootstrap_state_operator.service_account_id == google_service_account.bootstrap_state.name && google_service_account_iam_member.bootstrap_state_operator.role == "roles/iam.serviceAccountTokenCreator" && google_service_account_iam_member.bootstrap_state_operator.member == var.operator_member
    error_message = "Bootstrap state maintenance SA tokenCreator is granted only to operator."
  }
  assert {
    condition     = google_storage_bucket_iam_member.bootstrap_state.bucket == "aw-test-project-tfstate" && google_storage_bucket_iam_member.bootstrap_state.role == "roles/storage.objectAdmin" && google_storage_bucket_iam_member.bootstrap_state.member == "serviceAccount:aw-tf-bootstrap@aw-test-project.iam.gserviceaccount.com" && google_storage_bucket_iam_member.bootstrap_state.condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/bootstrap/')"
    error_message = "Bootstrap state writes are conditioned to prefix bootstrap/."
  }
  assert {
    condition     = google_storage_bucket_iam_member.bootstrap_state_list.bucket == "aw-test-project-tfstate" && google_storage_bucket_iam_member.bootstrap_state_list.role == google_project_iam_custom_role.state_list.name && google_storage_bucket_iam_member.bootstrap_state_list.member == "serviceAccount:aw-tf-bootstrap@aw-test-project.iam.gserviceaccount.com"
    error_message = "Bootstrap state SA receives bucket-scoped workspace discovery listing."
  }
  assert {
    condition     = !contains([for binding in values(module.terraform_roles.iam_bindings) : binding.member], "serviceAccount:aw-tf-bootstrap@aw-test-project.iam.gserviceaccount.com")
    error_message = "aw-tf-bootstrap must have no project roles."
  }
  assert {
    condition     = toset(keys(google_service_account_iam_member.operator)) == toset(["aw-tf-identity", "aw-tf-dev", "aw-tf-plan"]) && alltrue([for binding in google_service_account_iam_member.operator : binding.role == "roles/iam.serviceAccountTokenCreator" && binding.member == var.operator_member])
    error_message = "Operator tokens are per-SA only."
  }
  assert {
    condition     = google_service_account_iam_member.breakglass.role == "roles/iam.serviceAccountTokenCreator" && google_service_account_iam_member.breakglass.member == var.breakglass_member && google_service_account_iam_member.breakglass.service_account_id == google_service_account.terraform["aw-tf-identity"].name
    error_message = "Breakglass may impersonate identity only."
  }
  assert {
    condition     = alltrue([for binding in values(module.terraform_roles.iam_bindings) : binding.role != "roles/iam.serviceAccountTokenCreator"])
    error_message = "No project tokenCreator."
  }
  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access && google_storage_bucket.state.public_access_prevention == "enforced" && google_storage_bucket.state.versioning[0].enabled
    error_message = "State must be private, uniform and versioned."
  }
  assert {
    condition     = anytrue([for rule in google_storage_bucket.state.lifecycle_rule : anytrue([for c in rule.condition : c.num_newer_versions == 30])])
    error_message = "Keep thirty archived versions."
  }
  assert {
    condition     = length(module.baseline.org_policies) == 0 && module.baseline.audit_log == null && module.baseline.default_accounts_action == null && length(google_billing_account_iam_member.budget) == 0
    error_message = "Adopted-project baseline and billing IAM switches default off."
  }
  assert {
    condition     = output.project_number == "123456789012" && !contains(keys(output.iam_bindings), "budget")
    error_message = "Project number comes from adopted data source and budget IAM binding is omitted when disabled."
  }
  assert {
    condition     = google_storage_bucket_iam_member.plan.role == "roles/storage.objectViewer" && google_storage_bucket_iam_member.applier["aw-tf-dev"].condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/dev/')"
    error_message = "State writes must be prefix scoped; plan reads only."
  }
}

run "guards_opt_in" {
  command = plan
  variables {
    guard_constraints = ["iam.automaticIamGrantsForDefaultServiceAccounts", "iam.disableServiceAccountKeyCreation", "iam.disableServiceAccountKeyUpload"]
  }
  assert {
    condition     = length(module.baseline.org_policies) == 3 && alltrue([for policy in values(module.baseline.org_policies) : policy == "TRUE"])
    error_message = "Opt-in guard constraints must enforce all three policies."
  }
}

run "guards_reject_unknown_constraint" {
  command = plan
  variables {
    guard_constraints = ["iam.disableServiceAccountKeyCreationTypo"]
  }
  expect_failures = [var.guard_constraints]
}

run "audit_opt_in" {
  command = plan
  variables {
    enable_audit_config = true
  }
  assert {
    condition     = module.baseline.audit_log.service == "allServices" && module.baseline.audit_log.log_types == toset(["ADMIN_READ", "DATA_READ", "DATA_WRITE"])
    error_message = "Opt-in audit config must audit allServices."
  }
}

run "deprivilege_opt_in" {
  command = plan
  variables {
    enable_default_sa_deprivilege = true
  }
  assert {
    condition     = module.baseline.default_accounts_action == "DEPRIVILEGE"
    error_message = "Opt-in default SA deprivilege must set DEPRIVILEGE."
  }
}

run "billing_iam_opt_in" {
  command = plan
  variables {
    enable_billing_budget_iam = true
    billing_account_id        = "ABCDEF-ABCDEF-ABCDEF"
  }
  assert {
    condition     = length(google_billing_account_iam_member.budget) == 1 && google_billing_account_iam_member.budget[0].role == "roles/billing.costsManager" && google_billing_account_iam_member.budget[0].member == "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com" && output.iam_bindings["budget"].scope == "ABCDEF-ABCDEF-ABCDEF"
    error_message = "Opt-in billing budget IAM must bind costsManager to aw-tf-dev on billing_account_id."
  }
}

run "billing_iam_requires_account_id" {
  command = plan
  variables {
    enable_billing_budget_iam = true
    billing_account_id        = null
  }
  expect_failures = [var.billing_account_id]
}

run "billing_iam_rejects_blank_account_id" {
  command = plan
  variables {
    enable_billing_budget_iam = true
    billing_account_id        = "   "
  }
  expect_failures = [var.billing_account_id]
}

run "conditioned_dev_iam_in_bootstrap" {
  command = plan
  assert {
    condition = length(module.dev_iam.iam_bindings) == length(output.grantable_role_chunks) && alltrue([
      for binding in values(module.dev_iam.iam_bindings) :
      binding.member == "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com" && binding.scope == "aw-test-project" && binding.role == "roles/resourcemanager.projectIamAdmin"
    ])
    error_message = "Bootstrap grants the guarded project IAM role only to the dev applier."
  }
  assert {
    condition     = alltrue([for role in output.grantable_roles : !contains(["roles/owner", "roles/editor"], role) && !can(regex("^roles/iam\\..*Admin$", role))])
    error_message = "D6 must forbid basic and IAM admin roles."
  }
  assert {
    condition     = alltrue([for chunk in output.grantable_role_chunks : length(chunk) >= 1 && length(chunk) <= 10])
    error_message = "IAM Conditions allow at most 10 elements per hasOnly() list."
  }
  assert {
    condition     = toset(flatten(output.grantable_role_chunks)) == output.grantable_roles && length(flatten(output.grantable_role_chunks)) == length(output.grantable_roles)
    error_message = "The chunks must partition the approved allowlist with no loss or duplication."
  }
  assert {
    condition     = length(output.grantable_role_chunks) == ceil(length(output.grantable_roles) / 10)
    error_message = "Use the fewest conditioned bindings."
  }
  assert {
    condition = toset([for binding in values(module.dev_iam.iam_bindings) : binding.condition.expression]) == toset([
      for chunk in output.grantable_role_chunks : "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(chunk)})"
    ]) && length(toset([for binding in values(module.dev_iam.iam_bindings) : binding.condition.title])) == length(module.dev_iam.iam_bindings)
    error_message = "Each chunk gets its own hasOnly() expression and a distinct condition title."
  }
  assert {
    condition     = toset([for binding in values(module.terraform_roles.iam_bindings) : binding.role if binding.member == "serviceAccount:aw-tf-identity@aw-test-project.iam.gserviceaccount.com"]) == toset(["roles/iam.serviceAccountAdmin", "roles/iam.workloadIdentityPoolAdmin"])
    error_message = "Identity applier retains exactly SA and WIF administration."
  }
}
run "literal_grant_allowlist" {
  command = plan
  assert {
    condition = output.grantable_roles == toset([
      "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent",
      "roles/aiplatform.user", "roles/cloudsql.client", "roles/cloudsql.instanceUser",
      "roles/bigquery.jobUser", "roles/bigquery.dataViewer", "roles/artifactregistry.writer",
      "roles/run.developer", "roles/run.invoker", "roles/iam.serviceAccountUser",
      "roles/secretmanager.secretAccessor", "roles/cloudkms.cryptoKeyEncrypterDecrypter",
      "roles/workflows.invoker", "projects/aw-test-project/roles/pilot_durable_tasks_adapter",
    ])
    error_message = "D6 roles must match the literal approved runtime/deployer allowlist."
  }
}

run "optional_provisioning_permissions" {
  command = plan
  variables {
    enable_network            = true
    enable_nat                = true
    enable_cloud_sql          = true
    enable_kms                = true
    enable_bigquery_analytics = true
    enable_workflows          = true
  }
  assert {
    condition = toset(google_project_iam_custom_role.provisioning["network"].permissions) == toset([
      "compute.networks.create",
      "compute.networks.delete",
      "compute.networks.get",
      "compute.networks.update",
      "compute.networks.updatePolicy",
      "compute.networks.use",
      "compute.subnetworks.create",
      "compute.subnetworks.delete",
      "compute.subnetworks.expandIpCidrRange",
      "compute.subnetworks.get",
      "compute.subnetworks.setPrivateIpGoogleAccess",
      "compute.subnetworks.update",
      "compute.subnetworks.use",
      "compute.regionOperations.get",
      "compute.globalOperations.get",
    ])
    error_message = "Exact network provisioning permissions only."
  }
  assert {
    condition = toset(google_project_iam_custom_role.provisioning["nat"].permissions) == toset([
      "compute.routers.create",
      "compute.routers.delete",
      "compute.routers.get",
      "compute.routers.update",
      "compute.networks.use",
      "compute.subnetworks.get",
      "compute.subnetworks.use",
      "compute.regionOperations.get",
    ])
    error_message = "Exact nat provisioning permissions only."
  }
  assert {
    condition = toset(google_project_iam_custom_role.provisioning["cloud_sql"].permissions) == toset([
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
    ])
    error_message = "Exact cloud_sql provisioning permissions only."
  }
  assert {
    condition = toset(google_project_iam_custom_role.provisioning["kms"].permissions) == toset([
      "cloudkms.keyRings.create",
      "cloudkms.keyRings.get",
      "cloudkms.cryptoKeys.create",
      "cloudkms.cryptoKeys.get",
      "cloudkms.cryptoKeys.update",
      "cloudkms.cryptoKeys.getIamPolicy",
      "cloudkms.cryptoKeys.setIamPolicy",
    ])
    error_message = "Exact kms provisioning permissions only."
  }
  assert {
    condition = toset(google_project_iam_custom_role.provisioning["bigquery_analytics"].permissions) == toset([
      "bigquery.datasets.create",
      "bigquery.datasets.get",
      "bigquery.datasets.update",
      "bigquery.datasets.delete",
      "bigquery.datasets.getIamPolicy",
      "bigquery.datasets.setIamPolicy",
    ])
    error_message = "Exact bigquery_analytics provisioning permissions only."
  }
  assert {
    condition     = toset(keys(google_project_iam_member.provisioning)) == toset(["network", "nat", "cloud_sql", "kms", "bigquery_analytics"]) && alltrue([for binding in google_project_iam_member.provisioning : binding.member == "serviceAccount:aw-tf-dev@aw-test-project.iam.gserviceaccount.com" && binding.project == var.project_id])
    error_message = "Optional provisioning grants belong only to the dev applier in its project."
  }
  assert {
    condition     = google_project_iam_custom_role.workflow_adapter[0].role_id == "pilot_durable_tasks_adapter" && toset(google_project_iam_custom_role.workflow_adapter[0].permissions) == toset(["workflows.executions.create", "workflows.executions.list", "workflows.executions.cancel", "workflows.callbacks.list", "workflows.callbacks.send"])
    error_message = "Bootstrap owns the exact adapter role, without granting role management to dev."
  }
}
run "optional_permissions_default_off" {
  command = plan
  assert {
    condition     = length(google_project_iam_custom_role.provisioning) == 0 && length(google_project_iam_member.provisioning) == 0 && length(google_project_iam_custom_role.workflow_adapter) == 0
    error_message = "No optional provisioning rights unless enabled."
  }
}
run "workspace_listing_and_prefix_isolation" {
  command = plan
  assert {
    condition     = toset(google_project_iam_custom_role.state_list.permissions) == toset(["storage.objects.list"]) && toset(keys(google_storage_bucket_iam_member.applier_list)) == toset(["aw-tf-identity", "aw-tf-dev"]) && alltrue([for key, binding in google_storage_bucket_iam_member.applier_list : binding.bucket == "aw-test-project-tfstate" && binding.role == google_project_iam_custom_role.state_list.name && binding.member == "serviceAccount:${key}@aw-test-project.iam.gserviceaccount.com" && length(binding.condition) == 0])
    error_message = "Both appliers can list only the state bucket with a list-only custom role."
  }
  assert {
    condition     = google_storage_bucket_iam_member.applier["aw-tf-identity"].condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/identity/')" && google_storage_bucket_iam_member.applier["aw-tf-dev"].condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/dev/')" && google_storage_bucket_iam_member.dev_identity_reader.condition[0].expression == "resource.name.startsWith('projects/_/buckets/aw-test-project-tfstate/objects/identity/')"
    error_message = "Listing must not broaden object read/write or identity read grants."
  }
}

run "only_network_provisioning" {
  command = plan
  variables { enable_network = true }
  assert {
    condition     = toset(keys(google_project_iam_member.provisioning)) == toset(["network"]) && length(google_project_iam_custom_role.workflow_adapter) == 0
    error_message = "A single feature must grant only its provisioning role."
  }
}

run "only_cloud_sql_provisioning" {
  command = plan
  variables { enable_cloud_sql = true }
  assert {
    condition     = toset(keys(google_project_iam_member.provisioning)) == toset(["cloud_sql"]) && length(google_project_iam_custom_role.workflow_adapter) == 0
    error_message = "A single feature must grant only its provisioning role."
  }
}

run "only_kms_provisioning" {
  command = plan
  variables { enable_kms = true }
  assert {
    condition     = toset(keys(google_project_iam_member.provisioning)) == toset(["kms"]) && length(google_project_iam_custom_role.workflow_adapter) == 0
    error_message = "A single feature must grant only its provisioning role."
  }
}

run "only_bigquery_analytics_provisioning" {
  command = plan
  variables { enable_bigquery_analytics = true }
  assert {
    condition     = toset(keys(google_project_iam_member.provisioning)) == toset(["bigquery_analytics"]) && length(google_project_iam_custom_role.workflow_adapter) == 0
    error_message = "A single feature must grant only its provisioning role."
  }
}

run "nat_requires_network" {
  command = plan
  variables { enable_nat = true }
  assert {
    condition     = length(google_project_iam_member.provisioning) == 0
    error_message = "NAT flag alone must grant no network permissions."
  }
}

run "only_workflow_adapter" {
  command = plan
  variables { enable_workflows = true }
  assert {
    condition     = length(google_project_iam_custom_role.workflow_adapter) == 1 && length(google_project_iam_member.provisioning) == 0
    error_message = "Workflows opt-in creates the adapter role without granting custom-role management."
  }
}

mock_provider "google" {}
variables {
  project_id              = "aw-test-project"
  name                    = "aw-web"
  image                   = "example.invalid/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  service_account_email   = "aw-web@aw-test-project.iam.gserviceaccount.com"
  deployer_email          = "aw-deployer@aw-test-project.iam.gserviceaccount.com"
  iap_service_agent_email = "service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"
}
run "approved_interface" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_service.service.iap_enabled && google_cloud_run_v2_service.service.ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "Direct IAP defaults on."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.invoker["serviceAccount:service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"].role == "roles/run.invoker"
    error_message = "IAP service agent is an invoker."
  }
}
run "reject_invalid_principal" {
  command = plan
  variables {
    service_account_email = "human@example.test"
  }
  expect_failures = [var.service_account_email]
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}
run "reject_mutable_image" {
  command = plan
  variables {
    image = "example.invalid/web:latest"
  }
  expect_failures = [var.image]
}
run "reject_latest_secret" {
  command = plan
  variables {
    secret_env = { TOKEN = { secret_id = "token", version = "latest" } }
  }
  expect_failures = [var.secret_env]
}

run "direct_vpc_routes_all_traffic" {
  command = plan
  variables {
    network = { network = "aw-dev", subnetwork = "aw-dev-direct" }
  }
  assert {
    condition     = google_cloud_run_v2_service.service.template[0].vpc_access[0].egress == "ALL_TRAFFIC" && google_cloud_run_v2_service.service.template[0].vpc_access[0].network_interfaces[0].network == "aw-dev" && google_cloud_run_v2_service.service.template[0].vpc_access[0].network_interfaces[0].subnetwork == "aw-dev-direct"
    error_message = "The configured subnet must carry all traffic including internal Run calls."
  }
}

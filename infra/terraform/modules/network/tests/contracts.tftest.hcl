mock_provider "google" {}
variables {
  project_id = "aw-test-project"

}
run "approved_interface" {
  command = plan
  assert {
    condition     = !google_compute_network.vpc.auto_create_subnetworks && google_compute_subnetwork.direct.private_ip_google_access && length(google_compute_router_nat.egress) == 0
    error_message = "Explicit subnet, private Google access, NAT off."
  }
}
run "reject_other_region" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}
run "explicit_nat" {
  command = plan
  variables { enable_nat = true }
  assert {
    condition     = length(google_compute_router.nat) == 1 && length(google_compute_router_nat.egress) == 1 && google_compute_router_nat.egress[0].source_subnetwork_ip_ranges_to_nat == "LIST_OF_SUBNETWORKS"
    error_message = "Optional NAT is limited to the explicit Direct VPC subnet."
  }
}

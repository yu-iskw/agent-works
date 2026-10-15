resource "google_compute_network" "vpc" {
  #checkov:skip=CKV2_GCP_18:D10 provisions only VPC/subnet and optional NAT; no ingress allow rules are created, so GCP implied ingress deny remains in effect.
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
}
resource "google_compute_subnetwork" "direct" {
  project                  = var.project_id
  region                   = var.region
  name                     = "${var.name}-direct"
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
resource "google_compute_router" "nat" {
  count   = var.enable_nat ? 1 : 0
  project = var.project_id
  region  = var.region
  name    = "${var.name}-nat"
  network = google_compute_network.vpc.id
}
resource "google_compute_router_nat" "egress" {
  count                              = var.enable_nat ? 1 : 0
  project                            = var.project_id
  region                             = var.region
  name                               = "${var.name}-egress"
  router                             = google_compute_router.nat[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.direct.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

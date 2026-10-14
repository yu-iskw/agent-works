output "network" {
  description = "Reviewable network."
  value       = google_compute_network.vpc.id
}
output "subnetwork" {
  description = "Reviewable subnetwork."
  value       = google_compute_subnetwork.direct.id
}
output "direct_vpc_egress" {
  description = "Reviewable direct vpc egress."
  value       = { network = google_compute_network.vpc.id, subnetwork = google_compute_subnetwork.direct.id }
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = {}
}

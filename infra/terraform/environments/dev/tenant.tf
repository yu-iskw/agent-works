locals {
  test_tenant = {
    users = toset(["alice", "bob"])
    groups = {
      reviewers = { members = toset([]) }
    }
  }
}

output "test_tenant" {
  description = "The pilot test tenant."
  value       = local.test_tenant
}

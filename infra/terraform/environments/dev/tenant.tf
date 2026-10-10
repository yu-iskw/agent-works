locals {
  test_tenant = {
    users = toset(["alice", "bob"])
    groups = {
      reviewers = { members = toset([]) }
    }
  }
}

output "test_tenant" {
  description = "The pilot test tenant as data. Nothing in this stack creates or binds these users and groups."
  value       = local.test_tenant
}

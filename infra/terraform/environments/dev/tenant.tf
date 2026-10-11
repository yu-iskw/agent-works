output "test_tenant" {
  description = "The pilot test tenant."
  value = {
    users = toset(["alice", "bob"])
    groups = {
      reviewers = { members = toset([]) }
    }
  }
}

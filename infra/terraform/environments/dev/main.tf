module "dev" {
  source = "../../modules/environment"

  project_id         = var.project_id
  folder_id          = var.folder_id
  billing_account_id = var.billing_account_id

  identities = {
    bff = {
      account_id = "pilot-bff"
      grants     = ["observability"]
    }
    task_service = {
      account_id = "pilot-task-service"
      grants     = ["observability"]
    }
    tool_broker = {
      account_id = "pilot-tool-broker"
      grants     = ["observability"]
    }
    scheduled_execution = {
      account_id = "pilot-scheduled-exec"
      grants     = ["observability"]
    }
    deployer = {
      account_id = "pilot-deployer"
      grants     = ["run_deploy"]
    }
  }

  budget = {
    currency_code    = "USD"
    reference_amount = 100
    alert_at         = [0.5, 0.9, 1.0, 1.5]
  }
}

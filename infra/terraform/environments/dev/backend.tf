terraform {
  backend "gcs" {
    # Partial configuration: operator supplies bucket and replaces this placeholder
    # with -backend-config=impersonate_service_account=... (no credentials).
    prefix                      = "dev"
    impersonate_service_account = "aw-tf-dev@PROJECT_ID.iam.gserviceaccount.com"
  }
}

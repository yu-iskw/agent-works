terraform {
  backend "gcs" {
    # Partial configuration: operator supplies bucket and replaces this placeholder
    # with -backend-config=impersonate_service_account=... (no credentials).
    prefix                      = "identity/dev"
    impersonate_service_account = "aw-tf-identity@PROJECT_ID.iam.gserviceaccount.com"
  }
}

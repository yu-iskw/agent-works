# UNTRACKED operator override: bootstrap state lives in the GCS state bucket under bootstrap/.
# Uses the human operator's own keyless ADC (no SA keys); no impersonation SA owns bootstrap/ yet.
terraform {
  backend "gcs" {
    bucket = "ubie-yu-sandbox-tfstate"
    prefix = "bootstrap"
  }
}

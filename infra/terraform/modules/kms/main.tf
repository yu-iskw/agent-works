resource "google_kms_key_ring" "governance" {
  project  = var.project_id
  location = var.region
  name     = var.keyring
}
resource "google_kms_crypto_key" "governance" {
  key_ring        = google_kms_key_ring.governance.id
  name            = var.key
  rotation_period = "7776000s"
  lifecycle { prevent_destroy = true }
}
resource "google_kms_crypto_key_iam_member" "grant" {
  for_each      = var.encrypter_decrypter_emails
  crypto_key_id = google_kms_crypto_key.governance.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${each.key}"
}

resource "google_bigquery_dataset" "approved" {
  #checkov:skip=CKV_GCP_81:Approved analytics design has regional approved datasets with Google-managed encryption; governance KMS is a separate opt-in.
  for_each                   = var.datasets
  project                    = var.project_id
  dataset_id                 = each.key
  location                   = var.region
  delete_contents_on_destroy = false
}
locals { readers = { for pair in setproduct(var.datasets, var.reader_emails) : "${pair[0]}/${pair[1]}" => { dataset = pair[0], email = pair[1] }
} }
resource "google_bigquery_dataset_iam_member" "reader" {
  for_each   = local.readers
  project    = var.project_id
  dataset_id = google_bigquery_dataset.approved[each.value.dataset].dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${each.value.email}"
}
module "jobs" {
  source     = "../project_iam"
  project_id = var.project_id
  grants = { for email in var.job_user_emails : email => { member = "serviceAccount:${email}", roles = ["roles/bigquery.jobUser"] }
  }
}

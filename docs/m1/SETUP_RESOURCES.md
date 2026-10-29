# M1 live test resources

The live acceptance gates read real Drive, BigQuery and GitHub data under each member's own authorization. Yu creates and shares every resource below. The agent never creates cloud resources, datasets, Drive files or IAM bindings, and never writes to GitHub.

Two segments are configured: **alpha** (synthetic retail SaaS) and **beta** (synthetic clinic network). Every resource is dedicated to this campaign and named with the `aw-m1-` prefix, so cleanup can be scoped to it.

Member 1 is your main account. Member 2 is your second Google account. Both must be test users on the OAuth consent screen (`SETUP_OAUTH.md`).

## 1. Google Drive (research and business context)

The seed content is plain Markdown in this repository. Each file becomes one Google Doc.

| Segment | Folder to create       | Upload these files                                                     |
| ------- | ---------------------- | ---------------------------------------------------------------------- |
| alpha   | `aw-m1-alpha-research` | `fixtures/m1/drive/alpha/research/*.md`                                |
| alpha   | `aw-m1-alpha-context`  | `fixtures/m1/drive/alpha/context/*.md`                                 |
| beta    | `aw-m1-beta-research`  | `fixtures/m1/drive/beta/research/*.md`                                 |
| beta    | `aw-m1-beta-context`   | `fixtures/m1/drive/beta/context/*.md`                                  |
| both    | `aw-m1-restricted`     | one Doc named `AW-M1 Restricted: legal hold notes` with any short text |

Steps:

1. In Drive settings, turn on **Convert uploads to Google Docs editor format**, then upload each file into its folder. Keep the file names (for example `01-vendor-flagship-evaluation`). The name is how the expected-answer manifests in `fixtures/m1/expected/` refer to each source.
2. Share the four segment folders with **member 2** as **Viewer**.
3. Do **not** share `aw-m1-restricted` with member 2. It is the denial case: member 1 can read it, member 2 cannot, and neither segment allowlists it, so even member 1 gets a policy denial if a task points at it.
4. Open each Doc once after upload so its modified time is settled. The app reports each source's modified time as freshness. The stale documents are dated in their text and also flagged by the manifest.

**Docs publish target.** Approved briefs are created as new Google Docs in the approving member's own **My Drive** root, titled `[aw-m1 <segment>] <brief title>`. Nothing needs to be created for this. The app uses only `drive.file` for the write, so it can never modify existing documents. It tags each file with a private `appProperties` marker so that reconcile can find an uncertain write without creating a duplicate. Cleanup deletes only files that carry this run's marker.

## 2. BigQuery (metrics) in `ubie-yu-sandbox`

Create one dataset per segment in location `US`:

| Segment | Dataset       | Tables                             | Seed files                         |
| ------- | ------------- | ---------------------------------- | ---------------------------------- |
| alpha   | `aw_m1_alpha` | `daily_kpis`, `metric_definitions` | `fixtures/m1/bigquery/alpha/*.csv` |
| beta    | `aw_m1_beta`  | `daily_kpis`, `metric_definitions` | `fixtures/m1/bigquery/beta/*.csv`  |

The rows are synthetic and deterministic (`node scripts/m1/seed-data.mjs` regenerates them byte for byte). The expected answers are in `fixtures/m1/expected/<segment>-metrics.json`, computed from the CSVs and independent of any model output.

Commands (run on the Mac in this checkout):

```bash
for s in alpha beta; do
  bq --project_id=ubie-yu-sandbox mk --dataset --location=US \
    --description="Agent Works M1 synthetic test data ($s)" ubie-yu-sandbox:aw_m1_$s
  bq --project_id=ubie-yu-sandbox load --source_format=CSV --skip_leading_rows=1 \
    aw_m1_$s.daily_kpis fixtures/m1/bigquery/$s/daily_kpis.csv \
    day:DATE,region:STRING,channel:STRING,metric:STRING,value:NUMERIC
  bq --project_id=ubie-yu-sandbox load --source_format=CSV --skip_leading_rows=1 \
    aw_m1_$s.metric_definitions fixtures/m1/bigquery/$s/metric_definitions.csv \
    metric:STRING,definition:STRING,unit:STRING,owner:STRING,updated_at:TIMESTAMP
done
```

**Grants.** Members query with their own OAuth token, so each member needs:

| Principal          | Role                        | On                                            |
| ------------------ | --------------------------- | --------------------------------------------- |
| member 1, member 2 | `roles/bigquery.jobUser`    | project `ubie-yu-sandbox` (to run query jobs) |
| member 1, member 2 | `roles/bigquery.dataViewer` | dataset `aw_m1_alpha`                         |
| member 1, member 2 | `roles/bigquery.dataViewer` | dataset `aw_m1_beta`                          |

If member 1 is already a project owner, only member 2 needs the grants. Grant on datasets, not the project, so member 2 cannot see unrelated tables.

The app never accepts model-written SQL. Each segment runs only named, parameterised query templates against its allowlisted dataset. Each template caps rows (500) and bytes billed (10 MB), and runs as a dry run first. A request for any other dataset is a policy denial before BigQuery is called.

## 3. GitHub (read-only)

Repository `yu-iskw/agent-works` is public. Create two issues in it, one per segment, with the label `aw-m1-test`:

| Segment | Title                                                                | Body (paste as-is)                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| alpha   | `[aw-m1-test alpha] Let members download a task report as CSV`       | `Members want to download the evidence table and the report sections of a finished task as CSV from the task page. Must respect the same owner checks as the Markdown download. Synthetic test issue for Agent Works M1; do not implement.` |
| beta    | `[aw-m1-test beta] Return rate-limit headers from the workbench API` | `Clients need RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers on workbench API responses, per member and per segment. Synthetic test issue for Agent Works M1; do not implement.`                                          |

The app only reads. It never comments, labels or closes. The engineering proposals cite files and line ranges at a pinned commit, recorded per run (default `f96cac7243fdbdd6a1f419214aabf17e61e65b8f`, configurable).

The denial case needs no setup. Each segment allowlists only `yu-iskw/agent-works`, and the test asks for `yu-iskw/aw-m1-not-allowlisted`.

## 4. Record the identifiers

Add these to `~/.config/agent-works-m1/m1.env` (the same file as the OAuth secrets). The IDs are not secrets, but they are private to your account, so they stay out of the repository:

```bash
# Drive folder IDs (the part after /folders/ in the folder URL)
AW_M1_ALPHA_DRIVE_RESEARCH_FOLDER=
AW_M1_ALPHA_DRIVE_CONTEXT_FOLDER=
AW_M1_BETA_DRIVE_RESEARCH_FOLDER=
AW_M1_BETA_DRIVE_CONTEXT_FOLDER=
AW_M1_RESTRICTED_DRIVE_FOLDER=
# BigQuery
AW_M1_BIGQUERY_PROJECT=ubie-yu-sandbox
AW_M1_ALPHA_BIGQUERY_DATASET=aw_m1_alpha
AW_M1_BETA_BIGQUERY_DATASET=aw_m1_beta
# GitHub
AW_M1_GITHUB_REPOSITORY=yu-iskw/agent-works
AW_M1_GITHUB_PINNED_REF=f96cac7243fdbdd6a1f419214aabf17e61e65b8f
AW_M1_ALPHA_GITHUB_ISSUE=
AW_M1_BETA_GITHUB_ISSUE=
```

`pnpm m1:doctor` then checks, as each connected member and without printing data, that each folder is readable, that the datasets and tables exist with the expected row counts (1,656 each), and that the issues exist with the `aw-m1-test` label.

## 5. Cleanup after the campaign

- Docs created by the app: `pnpm m1:cleanup-docs --run <run-id>` deletes only files carrying that run's `appProperties` marker, created by the app (`drive.file`), in the signed-in member's Drive. It prints the titles first and asks for confirmation.
- Everything else (folders, datasets, issues, grants) is yours to remove by hand. The app never deletes them.

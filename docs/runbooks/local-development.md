# Local development with Docker Compose

`docker compose up` starts the web app, the API, Postgres and the in-repo fakes,
with source bind-mounted for hot reload. Containers authenticate to Google Cloud with
your own Application Default Credentials (ADC). No key files exist in the repository
or the images.

`compose.dev.yml` is a different stack: the fake-only environment that CI e2e drives
through `pnpm dev:up`. It publishes the same host ports as `compose.yaml`, so run one
stack at a time.

## Prerequisites

- Docker with Compose v2 (Docker Desktop, Rancher Desktop or OrbStack) running.
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install).
- Your user needs access to the dev project.

## First run

```bash
gcloud auth application-default login
cp .env.example .env
```

Edit `.env`:

- `GOOGLE_CLOUD_PROJECT`: the dev project id (`ubie-yu-sandbox` for the pilot).
- `HOST_UID` and `HOST_GID`: output of `id -u` and `id -g`.

Then start the stack:

```bash
docker compose up
```

The first start installs Linux dependencies and builds the packages in the one-shot
`bootstrap` service, which takes a few minutes. Later starts reuse the named volumes.
Use `docker compose up --wait` to block until everything is healthy.

## Services

| Service          | Host port | Role                                                 |
| ---------------- | --------- | ---------------------------------------------------- |
| `fake-iap`       | 8081      | Entry point: fake IAP proxy in front of `web`        |
| `fake-drive`     | 8082      | Fake Google Drive                                    |
| `fake-llm`       | 8083      | Fake model endpoint                                  |
| `api`            | 8084      | Agent API (talks to Postgres and the fakes)          |
| `web`            | 8085      | Web app (calls `api`)                                |
| `fake-directory` | 8086      | Fake directory for roles and groups                  |
| `fake-workspace` | 8087      | Fake Google Workspace and OAuth                      |
| `gcp-probe`      | 8090      | Calls Google Cloud with the mounted ADC              |
| `postgres`       | none      | Ledger and audit store                               |
| `bootstrap`      | none      | One-shot `pnpm install` and build, then exits        |
| `watch`          | none      | `tsc --watch` for domain, policy, fakes, api and web |
| `otel-collector` | 4318      | Optional, `docker compose --profile otel up`         |

All ports bind to 127.0.0.1 and can be changed in `.env` (see `.env.example`).
Browse `http://localhost:8081` with the header `x-fake-user: alice` to use the app
as the fake user.

## Check that it works

```bash
docker compose ps                 # every service healthy (bootstrap exits 0)
curl localhost:8090/gcp           # live Google Cloud call using the mounted ADC
```

`gcp-probe` calls `cloudresourcemanager.googleapis.com` `projects.get` for
`GOOGLE_CLOUD_PROJECT`, read-only. Its output lists the credential type, HTTP status
and project state, never tokens or credential contents. It is healthy only while that
call succeeds.

## Credentials

- The host `~/.config/gcloud` (override with `GCLOUD_CONFIG_DIR`) is mounted read-only
  at `/gcloud` in `api` and `gcp-probe` only. Containers cannot change your gcloud
  configuration. `GOOGLE_APPLICATION_CREDENTIALS` points at the mounted
  `application_default_credentials.json`.
- For a service that needs a specific identity, impersonate a service account instead
  of using a key:
  - `gcloud auth application-default login --impersonate-service-account=SA_EMAIL`
    makes the ADC file itself impersonate it, or
  - set `AW_IMPERSONATE_SERVICE_ACCOUNT` in `.env` to impersonate it on top of your
    user ADC (the probe does this).

  Either needs `roles/iam.serviceAccountTokenCreator` on that account.

- Service account key files are rejected by the probe. Do not add keys to `.env`, the
  repository or an image.

## Hot reload

The repository is bind-mounted at `/workspace`. `watch` recompiles TypeScript on every
save, and `nodemon` restarts each service when its compiled output changes. Expect a
few seconds between saving and the restart. File watching uses polling because file
events do not cross the host-to-VM bind mount on macOS and Windows.

Dependencies live in named volumes, not in your checkout, so they never mix with the
host's `node_modules`. After changing a `package.json` or the lockfile, run
`docker compose run --rm bootstrap`.

## Linux and UID mismatch

Containers run as `HOST_UID:HOST_GID`. The ADC file is mode 0600 and owned by you, so a
container running as another user cannot read it, and files written into the bind
mount would otherwise be owned by root. Docker Desktop on macOS remaps ownership, so
the defaults work there, but setting the variables is harmless.

## Troubleshooting

| Symptom                                        | Fix                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `gcp-probe` unhealthy, `invalid_grant`         | ADC expired: run `gcloud auth application-default login` again        |
| `gcp-probe` unhealthy, `PERMISSION_DENIED`     | Check the project id and that your user can read the project          |
| `gcp-probe` unhealthy, `SERVICE_DISABLED`      | Enable the Cloud Resource Manager API on the project                  |
| `required variable GOOGLE_CLOUD_PROJECT`       | Create `.env` from `.env.example`                                     |
| `port is already allocated`                    | Stop `compose.dev.yml` (`pnpm dev:down`) or change the port in `.env` |
| Permission denied on `/gcloud` or `/workspace` | Set `HOST_UID` and `HOST_GID` in `.env`, then `docker compose up -d`  |
| Stale state or a broken install                | `docker compose down -v` removes the database and dependency volumes  |

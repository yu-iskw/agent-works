# M1 identity and OAuth setup

> **Not needed for M1.** By Yu's decision (2026-10-30), M1 is mock-only apart from the real model. This document is kept for the later milestone that adds real sign-in and live integrations (`docs/m1/NEXT_MILESTONE.md`).

This is the one-time setup for real member sign-in and delegated source access. Yu does every step in a host browser. The agent never sees, prints or commits a secret value. The stack reads secrets only from a local file outside the repository.

## What the two credentials are for

| Credential                          | Proves                                                                                            | Used by                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host ADC (`~/.config/gcloud`)       | Nothing about the member. It only lets the segment APIs call Vertex AI.                           | `api-alpha`, `api-beta` (read-only mount)                                 |
| Google OAuth client (this document) | Member identity (OpenID Connect) and the member's own Drive, Docs and BigQuery access per segment | `web` for sign-in. `api-alpha` and `api-beta` for per-segment connections |
| GitHub OAuth App (this document)    | The member's own GitHub read access per segment                                                   | `api-alpha`, `api-beta`                                                   |

Ambient ADC is never used to read Drive, BigQuery or GitHub. A member who has not connected a source in a segment cannot use it there.

## 1. Google OAuth client (project `ubie-yu-sandbox`)

Open Google Cloud console, then **APIs & Services**, with project `ubie-yu-sandbox` selected.

1. **Enable APIs.** Enable Google Drive API (`drive.googleapis.com`), Google Docs API (`docs.googleapis.com`) and BigQuery API (`bigquery.googleapis.com`). Vertex AI is already enabled for P0.
2. **OAuth consent screen** (Google Auth Platform, then Branding and Audience):
   - User type: **External**. Publishing status: **Testing**.
   - App name: `Agent Works M1 (local)`. Support and developer email: your own.
   - Authorized domains: none (localhost only).
   - **Test users:** add both member accounts, your main account (member 1) and your second Google account (member 2). Only test users can sign in while the app is in Testing.
3. **Data access (scopes):** add exactly these.

   | Scope                                               | Why                                                                                                                |
   | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
   | `openid`, `email`, `profile`                        | Sign-in. The `web` service verifies the ID token's issuer, audience, expiry, signature and nonce.                  |
   | `https://www.googleapis.com/auth/drive.readonly`    | Read the allowlisted research and context folders for a segment.                                                   |
   | `https://www.googleapis.com/auth/drive.file`        | Create the approved brief as a new Google Doc and find it again for reconcile. Covers only files this app created. |
   | `https://www.googleapis.com/auth/bigquery.readonly` | Run the approved, parameterised read-only metric queries (`jobs.query` accepts this scope).                        |

   `drive.readonly` is a restricted scope. That is fine for test users in Testing mode. Expect the "Google hasn't verified this app" screen and choose **Continue**.

4. **Client** (Google Auth Platform, then Clients, then Create client):
   - Application type: **Web application**. Name: `agent-works-m1-local`.
   - Authorized JavaScript origins: `http://localhost:8280`
   - Authorized redirect URIs (both are required):
     - `http://localhost:8280/auth/google/callback` (sign-in)
     - `http://localhost:8280/connections/google/callback` (per-segment Drive, Docs and BigQuery connection)
   - Use `localhost`, not `127.0.0.1`. Google matches redirect URIs exactly.
5. Copy the client ID and client secret into the local secrets file in section 3. Do not paste them into chat.

Sign-in asks only for `openid email profile` (with offline access so the end-to-end runner can re-verify a real member, see section 4). The Drive, Docs and BigQuery scopes are requested separately, per segment, from that segment's Connections page.

## 2. GitHub OAuth App (read-only)

Out of scope by Yu's decision: there is no real GitHub OAuth App, and GitHub is mocked in tests. The steps below stay only as reference.

GitHub, then **Settings**, **Developer settings**, **OAuth Apps**, **New OAuth App**:

- Application name: `Agent Works M1 (local)`
- Homepage URL: `http://localhost:8280`
- Authorization callback URL: `http://localhost:8280/connections/github/callback`
- Leave "Enable Device Flow" off.

Generate a client secret and put both values in the secrets file. The app requests **no scopes**, so each member token can read only public repositories and nothing can be written. `yu-iskw/agent-works` is public, so that is enough. Each segment additionally allowlists repositories server-side, so a member cannot point a segment at another repository even if GitHub would allow the read.

## 3. Local secrets file (outside the repository)

Create the directory and file on the Mac:

```bash
mkdir -p ~/.config/agent-works-m1 && chmod 700 ~/.config/agent-works-m1
touch ~/.config/agent-works-m1/m1.env && chmod 600 ~/.config/agent-works-m1/m1.env
```

Fill `~/.config/agent-works-m1/m1.env` with:

```bash
# Google OAuth client from section 1
AW_M1_GOOGLE_CLIENT_ID=
AW_M1_GOOGLE_CLIENT_SECRET=
# Members: Google account emails, comma separated. Membership is enforced by each segment API.
AW_M1_ALPHA_MEMBERS=member1@example.com,member2@example.com
AW_M1_BETA_MEMBERS=member1@example.com,member2@example.com
# Shared secret for the end-to-end session runner (section 4). Any long random string:
#   openssl rand -hex 32
AW_M1_E2E_SESSION_SECRET=
```

Resource IDs (Drive folders, BigQuery datasets, GitHub issues) go in the same file. `SETUP_RESOURCES.md` lists them.

How the stack reads it:

- Compose bind-mounts `${AW_M1_SECRETS_DIR:-$HOME/.config/agent-works-m1}` **read-only** into `web`, `api-alpha` and `api-beta` at `/run/aw-m1`. The services parse the file at start-up. The docker CLI never reads it, so nothing is interpolated into `docker compose config` output.
- Builders, Postgres and the browser-test container do not get the mount, with one exception. The `e2e` container gets only the file `e2e-session.secret` (section 4).
- `pnpm m1:doctor` reports each key as `set` or `missing`. It never prints a value.
- Token encryption keys are generated by each service on first start into its own Docker volume (mode 0600). Nobody has to create or handle them.

## 4. Real members in browser tests

Playwright runs in a container, so it cannot use your host browser session. The flow is:

1. You sign in once per member at `http://localhost:8280` in your host browser and complete consent and MFA there. Then you connect Google and GitHub on each segment's Connections page.
2. Google returns a refresh token for the sign-in client (offline access). `web` stores it encrypted in its own database.
3. For a test run, the e2e container calls `POST /internal/e2e/session` with `AW_M1_E2E_SESSION_SECRET` and a member email. `web` uses that member's stored refresh token to get a **fresh ID token from Google**, verifies it exactly like a browser sign-in (issuer, audience, expiry, signature), checks it against the allowlisted member list, and only then issues a session cookie. If Google refuses, for example because the token was revoked or expired, the endpoint fails and the test reports that re-authentication is needed. Nothing is faked.
4. The endpoint is disabled unless the stack runs with `AW_M1_E2E_MODE=1` **and** `AW_M1_E2E_SESSION_SECRET` is set. In any other configuration it returns 404. It is served only by `web`'s internal listener on port 8081, which Compose never publishes, so only loopback and the internal Compose network can reach it. Every use is audited.

Playwright storage state lives in the Docker volume `aw-m1_e2e-auth`, never in the repository, reports or traces.

For the e2e container, also write the session secret alone into a second file:

```bash
grep '^AW_M1_E2E_SESSION_SECRET=' ~/.config/agent-works-m1/m1.env | cut -d= -f2- > ~/.config/agent-works-m1/e2e-session.secret
chmod 600 ~/.config/agent-works-m1/e2e-session.secret
```

## 5. Check

```bash
pnpm m1:doctor
```

It confirms, without printing values, that the file exists and is mode 0600, that every key is set, that the redirect URIs match the configured port, and that the Google discovery document and GitHub endpoints are reachable from the containers.

To revoke access later, remove the app at <https://myaccount.google.com/permissions> and <https://github.com/settings/applications>, or use **Disconnect** on a segment's Connections page.

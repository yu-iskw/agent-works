# Admin API and CLI

## Trusted authorization

All governance admin routes require verified IAP identity and roles from an
injected trusted directory resolver. Accepted roles are `Admin` (the existing
admin spelling), `admin` and `privacy-officer`. Other roles receive 403 before
body parsing or state access. Missing or invalid authentication receives 401.

Role headers, body role arrays and user-supplied actors never grant authority.
Command schemas reject extra properties. A directory error returns 503 and makes
no write. Do not map arbitrary client headers into `rolesFor` or `contextFor`.

The privacy-officer role is local to these governance route dependencies. This
bundle does not change global directory mappings, task authorization or cloud IAM.
An embedding application must supply its trusted privacy-officer group mapping.

## Routes

| Method and path                               | Command / result                                  |
| --------------------------------------------- | ------------------------------------------------- |
| `GET /v1/admin/governance/holds`              | Complete local command stream in `{ holds }`      |
| `POST /v1/admin/governance/holds`             | Set or release a hold                             |
| `GET /v1/admin/governance/deletions`          | Local requests in `{ requests }`                  |
| `POST /v1/admin/governance/deletions`         | Create a per-user request, HTTP 202               |
| `POST /v1/admin/governance/deletions/process` | Process an existing request                       |
| `GET /v1/artifacts/:id`                       | Authorized decrypted text in the explicit runtime |

List results contain privileged evidence. The local implementation does not
paginate lists. Keep this surface behind trusted administrative access and use
a new design for large evidence stores rather than exporting unbounded results
through a public endpoint.

Example hold command:

```json
{
  "commandId": "00000000-0000-4000-8000-000000000140",
  "target": { "kind": "owner", "id": "alice" },
  "action": "set",
  "reasonRef": "legal-case-139"
}
```

Release a hold with a new UUID, the same target and `"action": "release"`.
Use the original UUID only to retry the exact original command.

Example deletion command:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000139",
  "subject": "alice",
  "reasonRef": "privacy-case-139"
}
```

Example processing command:

```json
{ "requestId": "00000000-0000-4000-8000-000000000139" }
```

Malformed JSON, unknown command fields, invalid UUIDs and bodies over the command
limit return 400. Identity reuse or governance state conflicts return 409 with a
generic error. Database/service failure returns 503. Raw exception strings and
command contents are omitted from error responses.

The service-level `deletionPlan`, `rejectDeletion`, `revokeSource` and restore
helpers are available to trusted offline operator tooling. They are not additional
HTTP endpoints in this bundle.

## CLI client

The client implementation is `packages/cli/src/governance.ts`, exported as
`runGovernance` from the CLI package. It supports:

```text
aw governance --help
aw governance holds --url http://127.0.0.1:8084
aw governance deletions --url http://127.0.0.1:8084
aw governance hold hold-command.json --confirm --url http://127.0.0.1:8084
aw governance delete deletion-command.json --confirm --url http://127.0.0.1:8084
aw governance process processing-command.json --confirm --url http://127.0.0.1:8084
```

Mutations require a reviewed JSON command file and `--confirm`. The server still
performs authorization and schema validation. Confirmation is a local review
step; it is not an authorization grant. Command files contain case references
rather than confidential content.

The client uses HTTP(S) endpoints, rejects embedded username/password credentials,
rejects redirects and bounds request duration. It does not print assertion values,
server error payloads or internal exception details. Successful admin results are
privileged evidence and may include user subjects; protect the terminal output.

Programmatic callers can pass `{ apiUrl, assertion, fetch }` as the optional third
argument. `fetch` injection permits offline deterministic tests. The assertion is
sent only in `x-goog-iap-jwt-assertion`; there is no client role header.

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| 0         | Help or successful request                                    |
| 1         | Usage, missing configuration or missing mutation confirmation |
| 2         | Network, command-file, response or service failure            |
| 3         | Server returned 403                                           |

The executable dispatches `aw governance` in `packages/cli/src/aw.ts` to the
exported `runGovernance` client. The command is wired, and the client is also
independently usable and tested through its programmatic API.

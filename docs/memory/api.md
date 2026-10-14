# Own-memory API and CLI

## HTTP routes

All routes require a verified IAP assertion. The authenticated caller owns the
operation; no request includes an owner or tenant selector.

| Method | Path                 | Input                          | Result                               |
| ------ | -------------------- | ------------------------------ | ------------------------------------ |
| GET    | `/v1/memory/consent` | None                           | Consent, notice, tenant policy       |
| POST   | `/v1/memory/consent` | Consent command                | New consent revision                 |
| GET    | `/v1/memory`         | None                           | Current own memories across agents   |
| POST   | `/v1/memory/list`    | `{agent}`                      | Current memories for own agent scope |
| GET    | `/v1/memory/export`  | None                           | Versioned own export across agents   |
| POST   | `/v1/memory/edit`    | Item ID, agent, revision, text | New item revision                    |
| POST   | `/v1/memory/delete`  | Item ID, agent, revision       | Deletion acknowledgement             |

There is no unauthenticated read or public proposal route. Direct creation is
an internal server operation on trusted user-turn provenance.

A consent command is explicit and versioned:

```json
{ "enabled": true, "revision": 0, "noticeVersion": "memory-v1" }
```

Opt-out uses the current consent revision:

```json
{ "enabled": false, "revision": 1, "noticeVersion": "memory-v1" }
```

A revision command never changes origin, TTL, owner, tenant, classification, or
agent scope:

```json
{
  "id": "00000000-0000-4000-8000-000000000148",
  "agent": "default",
  "revision": 1,
  "text": "Prefer examples and concise explanations"
}
```

Delete uses the same item ID, agent and current revision, with no text field.
Every command is strict. Unknown authority/provenance fields, malformed UUIDs,
negative revisions, and oversized text produce `400 invalid_memory_command`.

`401 unauthenticated` means no verified caller. `403 memory_disabled` means a
policy/provenance boundary refused an operation. `409 memory_conflict` covers
missing/foreign IDs, stale revisions and legal-hold deletion conflicts without
revealing foreign content. `503 memory_unavailable` covers infrastructure errors.

Recall/list/export omit expired, sealed, opted-out, tenant-disabled, revoked and
currently unauthorized source-linked items. A source ACL failure is fail-closed.
Raw preservation under a hold never implies read permission.

## CLI

```sh
aw memory --help
aw memory consent --url http://127.0.0.1:8084
aw memory list --url http://127.0.0.1:8084
aw memory export --url http://127.0.0.1:8084
aw memory opt-in consent-on.json --url http://127.0.0.1:8084
aw memory opt-out consent-off.json --url http://127.0.0.1:8084
aw memory edit revision.json --url http://127.0.0.1:8084
aw memory delete deletion.json --url http://127.0.0.1:8084
```

The existing `AW_IAP_ASSERTION` mechanism supplies authentication. The command
never prints that credential. Endpoint URLs must use HTTP or HTTPS, and URLs
embedding user credentials are rejected. Requests refuse redirects and have a
five-second timeout.

Exit code zero indicates success, one invalid usage/endpoint, two request or
command failure, and three an API forbidden response. Error bodies and internal
exceptions are not printed. Successful export intentionally prints the user's
own accessible memories for their requested download.

Mutations require a JSON command file. Opt-in and opt-out require the `enabled`
value to match the selected subcommand. The API still validates the complete
command and current revision. CLI-side validation is not an authorization gate.

## Web handler

`createMemoryHandler` handles `/memory`, `/memory/consent`, `/memory/edit`,
`/memory/delete`, and `/memory/export`. It follows the repository's offline
server-rendered handler pattern. Use `createMemoryWebApp` from `apps/web/app/memory/runtime.ts` as the
web composition root; it mounts memory and falls back to existing web routes. It consumes the same API as the CLI.

The page shows the notice and tenant/user activation state, revision, origin
task, expiry, classification, and edit/delete/export/opt-out controls. Held delete
controls are disabled. A failed backend request displays a safe reload message.
The page and export response have `no-store` caching.

The direct handler tests validate request forwarding, token enforcement, safe
rendering, body limits, command mapping and errors without requiring network
sockets. The Playwright smoke test starts a disposable HTTP server and exercises
inspection, revision, export, deletion, and opt-out in a real browser.

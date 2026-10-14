# Offline workspace connectors

Issue #146 adds Google Docs draft output, Calendar read/create, and Gmail
read/draft using caller credentials and fake Google API handlers. Gmail send is
registered as an external-send capability and is always denied.

| Tool                   | Side effect   | Scope                      | Human approval               |
| ---------------------- | ------------- | -------------------------- | ---------------------------- |
| `docs.createDraft`     | WRITE_LOW     | `drive.file`               | Exact payload, one execution |
| `calendar.listEvents`  | READ          | `calendar.events.readonly` | No                           |
| `calendar.createEvent` | WRITE_LOW     | `calendar.events`          | Exact payload, one execution |
| `gmail.searchThreads`  | READ          | `gmail.readonly`           | No                           |
| `gmail.createDraft`    | WRITE_LOW     | `gmail.compose`            | Exact payload, one execution |
| `gmail.send`           | EXTERNAL_SEND | Never requested            | Always denied                |

Scopes in the table use the `https://www.googleapis.com/auth/` prefix. A Calendar
write grant also covers Calendar reads. Gmail compose never grants Gmail reads.

## Entry points

- Domain: `packages/domain/src/workspace-tools.ts` and its sibling schema,
  manifest, payload, scope, and response modules.
- Runtime assembly: `apps/api/src/connectors/runtime.ts`.
- HTTP adapters: `apps/api/src/connectors/{docs,calendar,gmail}/adapter.ts`.
- Fake HTTP APIs: `packages/fakes/src/google-{docs,calendar,gmail}.ts`.
- Meeting prep: `apps/api/src/skills/meeting-prep.ts`.
- Approval handler and payload diff:
  `apps/web/app/approvals/workspace-{handler,page,card}.tsx`.
- CLI: `aw connectors [list]`, using the existing `/v1/oauth/connections` API.

The feature uses the existing CredentialsPort and ApprovalStore. Both memory and
Postgres approval implementations retain the same payload binding and intent
recovery contract. No connector migration or separate credential database is
introduced.

## Dev-stack integration

`pnpm dev:up --wait` mounts connector routes in the API and workspace approval
pages at `/approvals/workspace/{approvalId}` in the web server. Compose enables
`AW_DEV_STACK=1` and starts `fake-workspace` on `127.0.0.1:8087`; its `workspace`
fake-server role serves OAuth, Docs, Calendar, and Gmail from one process.
`OAUTH_URL` uses the internal Compose hostname and `OAUTH_PUBLIC_URL` supplies the
browser-visible consent URL. The fake accepts its opaque OAuth token reference
as a bearer credential and rechecks scopes, ownership, expiry, and revocation on
every request. Docs destinations are `alice-folder` and `bob-folder`, owned by
the matching fake user.

`createDevWorkspaceRuntime` uses the existing Postgres credential and approval
stores. Execution requires an owned task whose published skill declares the
tool, current Employee membership, and suspension enforcement. Approval decisions
require current Reviewer or Admin membership; execution rechecks the approver.
The configured meeting-prep skill is registered in the task dispatcher. Outside
the opted-in dev stack, meeting prep remains unconfigured and fails closed.

Domain consumers import `@agent-works/domain/workspace-tools`, with source types,
a development condition, and a built runtime export following the data-governance
pattern. Connector operations and schemas are included in the generated OpenAPI
contract and client; fingerprints include connector route sources.

See [Architecture](architecture.md), [API](api.md), [Approval binding](approvals.md),
[Operator evidence](operator-evidence.md), and [Testing](testing.md).

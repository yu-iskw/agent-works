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

## Deployment integration boundary

The issue's exclusive write paths do not include `apps/api/src/server.ts`,
`apps/api/src/routes/index.ts`, `apps/web/app/web-app.ts`, package export maps,
the fake service entrypoint, or OpenAPI source/generated artifacts. This change
provides injectable runtime and HTTP handler factories within the allowed paths;
it does not change those protected application mount points. The default skill
registry lists meeting prep, which fails closed until configured.

An application integrator must mount `runtime.routes` in its trusted HTTP route
table, register `runtime.skill` in its task dispatcher, and select
`createWorkspaceApprovalsHandler` for `/approvals/workspace/`. These are still
required before the normal dev-stack entrypoints expose the feature. The API
route factory tests exercise the full authenticated preparation/decision/write
flow directly. The package-local domain build is used to import the new domain
module without changing the protected package export map.

See [Architecture](architecture.md), [API](api.md), [Approval binding](approvals.md),
[Operator evidence](operator-evidence.md), and [Testing](testing.md).

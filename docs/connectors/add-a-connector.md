# Add a connector tool

This guide adds one tool to an existing first-party connector and publishes it as a new
version. The example adds `github.readIssue` to `github` as version `1.1.0`. It is
illustrative and not in the catalog.

The catalog is closed on purpose. `connectorManifestSchema` accepts only the providers
`google`, `github` and `notes`, and only capabilities named in `CAPABILITY_PROVIDER`
(`packages/domain/src/teamwork.ts`). `notes` is the first-party MCP server. A new capability
or provider is a larger change. See [Beyond a new tool](#beyond-a-new-tool) and
[MCP servers](#mcp-servers).

`packages/domain/src/connector-docs.test.ts` parses the manifest and the handler map below,
so a copy of this page that no longer validates fails CI.

## Steps

1. **Pick the capability and its side effect.** The tool joins an existing capability.
   `docs.publish` and `notes.write` are the write capabilities (`WRITE_CAPABILITIES`). Every
   tool under a read capability must have side effect `READ`, and every tool under a write
   capability must not. The schema rejects a mismatch.
2. **Write the tool manifest.** Add it to the connector in
   `packages/domain/src/connector-catalog.ts` with the local `tool()` helper. It expands to
   the JSON below. Tool names are unique across the connector.
3. **Bump the version.** A published version is immutable. Changing the manifest means a
   new semver `x.y.z`.
4. **Pin the hash.** Run `pnpm --filter @agent-works/domain test`. The failing assertion in
   `connector-catalog.test.ts` prints the new `connectorContentHash`. Add one line for the
   version to `PUBLISHED_CONNECTOR_HASHES`. Never edit a line for a published version.
   That test expects exactly one pin per manifest in `CONNECTOR_CATALOG` and
   `MCP_SERVER_CATALOG`. Keeping `1.0.0` next to `1.1.0` (so `rollback` has a target) needs
   the listing and that test updated first. See [Marketplace](marketplace.md#known-limitations).
5. **Add the handler** to `HANDLERS` in `apps/api/src/teamwork/gateway.ts`. Use
   `toolHandler` with a strict Zod schema. Never accept a member, segment or token in the
   input. The gateway supplies the token.
6. **Call it through the gateway.** Use `invoke(deps, member, { tool, input, taskId, assignmentId })`.
   Never call `deps.sources` directly from new code.
7. **Test it.** Add cases to `apps/api/src/teamwork/gateway.test.ts` for denial when the
   capability is disabled, for a forged identity key in the input, and for wrapped source
   text.

### The manifest

Copy this block. The doc test parses it with `connectorManifestSchema`, and checks that
its `github.read` tool equals the one in the catalog.

```json
{
  "id": "github",
  "version": "1.1.0",
  "displayName": "GitHub",
  "summary": "Read repository content the member can access.",
  "publisher": "agent-works",
  "capabilities": [
    {
      "id": "github.read",
      "tools": [
        {
          "apiVersion": "internal.agents/v1",
          "kind": "ToolDefinition",
          "metadata": {
            "name": "github.read",
            "version": "1.0.0",
            "owner": "workspace-integrations"
          },
          "spec": {
            "description": "Read GitHub repository content",
            "executor": "connector://github.read",
            "inputSchemaRef": "connectors/github.read",
            "sideEffect": "READ",
            "dataClassificationMax": "CONFIDENTIAL",
            "lifecycle": "PUBLISHED",
            "permissions": {
              "workloadCapability": "github.read",
              "userAuthority": "delegated",
              "resourceConstraint": "caller-scoped provider ACL"
            },
            "approval": { "required": false, "policy": "none" },
            "execution": { "timeoutSeconds": 30, "retries": 2, "idempotency": "required" },
            "evidence": {
              "logRequestDigest": true,
              "logExternalObjectId": true,
              "redactFields": ["query", "content"]
            }
          }
        },
        {
          "apiVersion": "internal.agents/v1",
          "kind": "ToolDefinition",
          "metadata": {
            "name": "github.readIssue",
            "version": "1.0.0",
            "owner": "workspace-integrations"
          },
          "spec": {
            "description": "Read one GitHub issue the member can open",
            "executor": "connector://github.readIssue",
            "inputSchemaRef": "connectors/github.readIssue",
            "sideEffect": "READ",
            "dataClassificationMax": "CONFIDENTIAL",
            "lifecycle": "PUBLISHED",
            "permissions": {
              "workloadCapability": "github.read",
              "userAuthority": "delegated",
              "resourceConstraint": "caller-scoped provider ACL"
            },
            "approval": { "required": false, "policy": "none" },
            "execution": { "timeoutSeconds": 30, "retries": 2, "idempotency": "required" },
            "evidence": {
              "logRequestDigest": true,
              "logExternalObjectId": true,
              "redactFields": ["query", "content"]
            }
          }
        }
      ],
      "requiredScopes": []
    }
  ]
}
```

### The handler map

`defineConnector(manifest, handlers)` fails at load when a manifest tool has no handler or a
handler has no tool. The map in `gateway.ts` gains one entry. The doc test reads the keys.

```ts
// HANDLERS.get('github') in apps/api/src/teamwork/gateway.ts
{
  'github.read': readTool(z.enum(['github_issue', 'github_code'])),
  'github.readIssue': toolHandler(
    z.strictObject({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200),
      issueNumber: z.number().int().positive(),
    }),
    async ({ deps, token }, input) => {
      const result = await deps.sources.read({
        kind: 'github_issue',
        query: '',
        metrics: null,
        ...input,
        token,
      });
      return { value: result, untrusted: result.items.map((item) => item.excerpt) };
    },
  ),
}
```

`untrusted` lists provider-authored text. The gateway wraps each entry as source data
before it reaches a model.

## What the gateway gives the handler for free

The handler runs only after these checks pass on that call:

- the member is still in the segment;
- the tool is in the registry (otherwise `unknown_tool`);
- the tool's capability is in `segmentCapabilities`, so an admin disable denies at once
  with `capability_disabled`;
- `capabilityStates` is effective for the member, teammate and task;
- the input parsed against the strict schema;
- for a tool whose manifest requires approval, the `wb_approvals` digest and revision
  match. Only the segment policy `segment-publish-v1` is wired. Any other policy denies,
  so an MCP write (policy `mcp-write-v1`) is refused.

## Beyond a new tool

These changes need more than a manifest and a handler. Check the ADR index first; a
change in the decision boundary is a `manage-adr` Challenge, not an in-place edit.

| Change                   | Also touch                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New capability           | `CAPABILITY_PROVIDER` and, for a write, `WRITE_CAPABILITIES`; source kinds in `SOURCE_KINDS` and `SOURCE_CAPABILITY`; `sources/live.ts` and `sources/fixture.ts` |
| New provider             | `connectorProviderSchema`, the `TokenSource` provider type, and the connection and OAuth flow                                                                    |
| Flagship broker tool     | The manifest in `packages/domain/src/workspace-tools.ts` and one entry in `createWorkspaceRegistry` (`apps/api/src/connectors/ports.ts`)                         |
| Out-of-process connector | `runtime.artifactDigest` in the manifest, and a real `RuntimeManager`. Not built; see the runbook.                                                               |
| New MCP server           | `MCP_SERVER_CATALOG`, the provider id, and the gateway transport. See [MCP servers](#mcp-servers).                                                               |

## MCP servers

An MCP server is a manifest in `MCP_SERVER_CATALOG` with `transport: 'mcp'`. The `notes`
server is the only one. It sits apart from `CONNECTOR_CATALOG`, so the native connector
catalog and its listing do not change when a server is added. The adapter's guarantees are in
[Marketplace](marketplace.md#what-the-adapter-guarantees).

To add one:

1. **Write the manifest.** Put it in `MCP_SERVER_CATALOG`. Build each tool with the
   `mcpTool()` helper in `connector-catalog.ts`. Its `executor` must be `mcp://<id>/<tool>`,
   and the tool name is the name the server exposes. The schema rejects any other executor.
2. **Add the provider.** Add the id to `connectorProviderSchema`, and widen the `satisfies`
   type on `CAPABILITY_PROVIDER` in `packages/domain/src/teamwork.ts`. The OAuth `Provider`
   type stays `google` and `github`.
3. **Keep it opt-in.** `DEFAULT_SEGMENT_CAPABILITIES` leaves out only the provider `notes`.
   Extend that filter for a new provider, or its capabilities join the default set.
4. **Skip OAuth only when no member account is needed.** Add the provider to
   `CONNECTIONLESS_PROVIDERS` only in that case.
5. **Pin the hash.** Add one `PUBLISHED_CONNECTOR_HASHES` line, as for a connector.
6. **Wire the gateway.** Pins come from the manifest. `callNotes` in
   `apps/api/src/teamwork/gateway.ts` shows the pattern. `Deps.mcp` is one transport factory,
   so a second server needs its own factory first.
7. **Keep writes refused.** A write tool needs an approval policy the gateway accepts.
   Until one exists, the gateway denies the write before its handler runs.

## Check your work

```bash
pnpm --filter @agent-works/domain test      # schema, catalog hash pin, this guide
pnpm --filter @agent-works/api test         # gateway and registry (Postgres suites need Docker)
pnpm build && pnpm typecheck
```

See also [Marketplace](marketplace.md) and the
[operations runbook](../runbooks/connector-operations.md).

# MCP task contract `aw.task.v1`

`apps/api/src/teamwork/mcp-task/index.ts` exports the approved agent registry and asynchronous task client.
This is an Agent Works application contract over MCP tools.
**MCP itself does not define this lifecycle.** Other agents need an adapter mapping their lifecycle to these tools.
An accepted submission means the agent created or recognized a task. It never implies task success.

## Approved agent configuration

`parseAgentRegistry(json, { allowLoopback })` takes an array of entries with exactly these fields.
The segment owns the allowLoopback policy. Production startup passes `false`.
`connectAgentTask(agent, { allowLoopback })` validates again before constructing its transport and defaults to `false`.
Reference-agent callers must explicitly pass `allowLoopback: true` when connecting, even if the registry already permits loopback.
The integration reads the JSON file named by `AW_BOT_MCP_AGENTS` and passes its parsed contents to this function.
This module does not read environment variables or files.

```json
[
  {
    "agentId": "local-reference",
    "displayName": "Local reference task agent",
    "protocol": "mcp",
    "contract": "aw.task.v1",
    "endpoint": "http://127.0.0.1:8090/mcp",
    "allowedHosts": ["127.0.0.1:8090"],
    "supports": {
      "cancel": true,
      "lookupByIdempotencyKey": true,
      "reportsCost": true
    },
    "maxInputBytes": 65536,
    "maxOutputBytes": 65536,
    "callTimeoutMs": 10000,
    "dataClassification": "Test data sent externally"
  }
]
```

All fields are required. Unknown fields, duplicate agent IDs, unsupported protocols, and absent contracts are rejected.
Registry errors contain field paths, without configuration values or upstream messages.
Registry entries and their nested capability and host lists are immutable.
`dataClassification` is the preview disclosure for data sent externally.
HTTPS is required except when `allowLoopback` admits HTTP on `127.0.0.1` or `localhost`.
Credentials and URL fragments are rejected. Host allowlists compare exact `URL.host`, including a non-default port.
Every HTTP request passes the existing MCP host guard. Redirects are refused with `mcp_redirect`.
This contract supplies no authentication or agent discovery.

`maxInputBytes` and `maxOutputBytes` are positive integers up to 16 MiB.
`callTimeoutMs` is a positive integer up to 300000.
The input limit counts UTF-8 bytes of the JSON submission object, including the key and instruction.
An oversized input returns `{ "kind": "rejected", "code": "mcp_input_too_large" }` before a network call.
Invalid JSON-compatible inputs return `invalid_input`.
Output limits count UTF-8 bytes of the tool's JSON text, including the output and cost wrapper.
The HTTP envelope also has a streaming limit of `max(65536, maxOutputBytes * 6 + 16384)` bytes.
The larger envelope allowance covers JSON escaping and MCP discovery metadata.

## MCP transport and manifest

The client uses the installed SDK's `Client` and `StreamableHTTPClientTransport` through the existing guarded HTTP transport.
It initializes MCP and verifies the complete five-tool manifest before returning a client, then rechecks before every call.
Missing, extra, repeated, or incorrectly annotated tools cause `mcp_manifest_mismatch`.
All five tools must exist even if a capability is disabled in the registry.
Read tools declare `readOnlyHint: true` and cannot declare `destructiveHint: true`.
Submit and cancel declare `readOnlyHint: false`.

Each tool accepts an MCP arguments object and returns **one** text content item containing a JSON object.
Non-text content, multiple text items, malformed JSON, and invalid lifecycle shapes are refused.
MCP `isError` responses become the fixed `mcp_tool_error` error.
Raw exceptions, error messages, causes, and response text never become client error messages.

| Tool          | Arguments                              | JSON response                                                                        |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `task.submit` | `{idempotencyKey, instruction, input}` | `{kind:"accepted", handle, duplicate}` or `{kind:"rejected", code}`                  |
| `task.status` | `{handle}`                             | `{state, progress?, code?}` with the state variants below                            |
| `task.result` | `{handle}`                             | `{output, cost?}` after success                                                      |
| `task.cancel` | `{handle}`                             | `{kind}` with `cancelled`, `already_terminal`, `unsupported`, or `uncertain`         |
| `task.lookup` | `{idempotencyKey}`                     | `{kind:"found", handle}` or `{kind}` with `not_found`, `unsupported`, or `uncertain` |

Task status variants are `{state:"queued", progress?}`, `{state:"running", progress?}`, `{state:"succeeded"}`, `{state:"failed", code}`, `{state:"cancelled"}`, and `{state:"not_found"}`.

Handles and idempotency keys are nonempty strings up to 256 characters.
Instructions are nonempty strings, bounded by the full input limit.
`input` and `output` are JSON values. `progress` is at most 1000 characters.
Wire rejection and task failure codes belong to a fixed safe vocabulary.
The vocabulary is `invalid_input`, `idempotency_conflict`, `task_failed`, `task_not_ready`, `task_not_found`, and `mcp_tool_error`.
An agent adapter maps its own error details to these codes. Unrecognized codes are an invalid response.

## Recovery, cancellation, and cost

The caller persists `bot:<taskId>:<stepId>:<attempt>` before submitting.
The reference agent atomically deduplicates this key within its process and returns the original handle with `duplicate: true`.
Reusing a key with different instruction or input JSON returns `idempotency_conflict` without creating another task.
Identical redelivery must preserve the JSON representation, including object property order, for this reference implementation.

A timeout, unavailable transport, caller abort after submission starts, tool error, or malformed submit response can hide a created task.
The client returns `uncertain` with `mcp_timeout`, `mcp_unavailable`, or `mcp_invalid_response`.
It never retries submission automatically. `task.lookup` recovers a handle when supported.
An already-aborted signal returns a definite local rejection with `mcp_cancelled` before sending anything.
The caller retains an uncertain outcome if lookup is unsupported, unavailable, or does not establish what happened.
The integration must not treat a transient `not_found` as proof that no delayed submission can still create a task.

The caller polls status and requests a result only after `succeeded`.
`status` and `result` throw `McpAdapterError` on transport, cancellation, size, or response validation failures.
They never invent a terminal task state from a network error.
Cancel and lookup return `uncertain` on transport or validation failure.
Disabled cancel and lookup capabilities return `unsupported` locally without any MCP call.
`already_terminal` covers completed, failed, cancelled, and unknown handles on the reference agent.
The reference agent never changes a cancelled task back to succeeded, even after its original completion time.
The durable workflow integration must independently fence late results against local cancellation or revoked authority.

Reported cost has shape `{basis:"reported", amountMicros, currency}` with a nonnegative safe integer amount and three uppercase currency letters.
Missing cost becomes `{basis:"unknown"}`. It never becomes a zero estimate.
If the registry disables `reportsCost`, the client reports unknown even when a response includes a cost.
The reference agent reports 1234 micros in USD for ordinary tasks. This is deterministic test data, not a price estimate.

## Local reference service and fault controls

The standalone process is built by `pnpm build` and starts with this command.

```sh
node apps/api/dist/teamwork/mcp-task/reference-agent-server.js --port 8090
```

Port `0` requests an available port. The first stdout line is JSON with `reference: true` and the actual endpoint.
SIGTERM and SIGINT close active transports and the HTTP listener.
The service binds exclusively to `127.0.0.1` and checks the HTTP Host header with SDK DNS rebinding protection.
It serves MCP POST requests at `/mcp`. Other paths return 404 and other methods return 405.
The reference HTTP request body limit is 1 MiB, including its JSON-RPC envelope.
Each HTTP request gets its own stateless `McpServer` and `StreamableHTTPServerTransport`.
The task map belongs to the process. A new client or MCP session can recover existing handles and results while the process stays running.
Restarting the agent process loses its in-memory task map. There is no persistence file option.

The service is an unauthenticated deterministic **local reference agent**, not a production agent.
It echoes JSON test input and has no model, credentials, external effects, durable storage, or production billing.
Its default elapsed-time transitions are queued at submission, running after 100 ms, and terminal after 1000 ms.
The reusable `startReferenceAgent` export accepts `now`, `queuedMs`, and `completionMs` for deterministic tests.
These controls are local code options, not remote administrative tools.

The following instruction prefixes enable one fault per task.

| Prefix                         | Behavior                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[reference:drop-submit]`      | Creates the task, destroys the HTTP response on the first delivery, and permits lookup recovery. Duplicate delivery returns the original handle. |
| `[reference:slow-submit]`      | Creates the task, then delays its response for 2000 ms. A shorter client timeout produces uncertainty.                                           |
| `[reference:tool-error]`       | Returns an MCP tool error with test upstream text, without creating a task. The client conservatively reports uncertainty.                       |
| `[reference:fail]`             | Advances to `failed` with `task_failed`.                                                                                                         |
| `[reference:oversized-output]` | Completes with a 128 KiB string. Configure a smaller output limit to test rejection.                                                             |
| `[reference:invalid-json]`     | Creates a task but returns malformed JSON text on submit. Lookup still finds the task.                                                           |
| `[reference:never]`            | Reaches running and remains there until cancelled.                                                                                               |
| `[reference:unknown-cost]`     | Completes successfully and omits cost from the wire result.                                                                                      |

Other instructions complete normally. Simultaneous submissions with the same key exercise duplicate delivery without another directive.
For R5 end-to-end tests, keep this process alive across worker or client restarts, configure its exact endpoint host in the registry, and persist handles before polling.
The test-only `omitTool` and `extraTool` startup options exercise manifest refusal.

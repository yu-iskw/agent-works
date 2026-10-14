# Generated client and CLI

`ApiClient` derives methods and request/response types from OpenAPI. Its transport validates request bodies and mandatory operation headers before dispatch, validates successful JSON responses, and exposes status plus a restricted API error code on failure. It encodes path parameters, rejects URL credentials/query strings, permits local HTTP development origins, and requires HTTPS elsewhere. Redirects are refused.

```ts
import { ApiClient } from './packages/api-contract/dist/client.generated.js';

const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8084' });
const task = await client.readTask('task-1');
const events = await client.taskEvents(task.id);
```

Supply an IAP assertion through the client `assertion` option in authenticated deployments. Tests inject `fetch` and use recorded fixtures; they do not contact Google services.

## CLI commands

The existing CLI dispatches `tasks` and `approvals` through the generated client. `AW_API_BASE_URL` chooses the base URL (default `http://127.0.0.1:8084`); `AW_IAP_ASSERTION` supplies the authentication assertion. Neither value is emitted by the command.

```sh
aw tasks read task-1
aw tasks events task-1
aw tasks cancel task-1 idempotency-key
aw tasks submit request.json idempotency-key
aw approvals read approval-1
aw approvals decide approval-1 approve payload-sha256 csrf-token
aw approvals decide approval-1 reject payload-sha256 csrf-token
```

A submit file contains the `kind: "submit"` request arm, objective, skill ID, source allowlist, requested outputs and execution policy. The generated validator rejects unknown trusted identity fields before any HTTP request. Idempotency keys and CSRF tokens retain the existing route semantics.

A successful command writes one JSON result and returns zero. Usage errors and malformed input return one. Contract/API failures return one and may write `ERROR <status> <safe-code>`; malformed successes become `invalid_response`. Server response text and credentials are not reflected in errors. Existing `policy explain` and `admin` commands retain their behavior.

The client does not grant privileges. Approval requester/reviewer separation, digest binding, expiry, cancellation and resource access are enforced by existing routes and ports. Route feature flags can still return 501.

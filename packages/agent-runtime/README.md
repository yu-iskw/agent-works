# @agent-works/agent-runtime

Runs the `ask` agent in-process and provides the eval glue used by `aw agent` and `aw eval`.

It owns:

- the `AgentRunner` port (`src/runner-port.ts`, exported from `@agent-works/agent-runtime/port`);
- the native ADK runner (`createAdkRunner`: `LlmAgent` with `InMemoryRunner`) and `FetchLlm`, the fake model reached through an injected `fetch`;
- the live Vertex model configuration (`readVertexConfig`, `createLiveModel`);
- `runAgent` and `runEval`, which score observations with `tools/evals` and add the `run` record.

It must not import:

- `apps/api` or `packages/cli`;
- `@google/adk` from the `/port` entry or from the eval contract path, so injected runners never load ADK;
- anything that starts a server or opens a socket. Fake mode is server-free by design.

See [docs/evals/README.md](../../docs/evals/README.md#server-free-agent-runs) for the commands and the fake/live boundary, and [ADR 0005](../../docs/adr/0005-agent-runtime-package.md) for why this package exists.

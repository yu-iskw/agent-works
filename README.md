# agent-works

An enterprise Gemini-style agent platform: a web app, an API and a policy layer with
Google Workspace connectors, built TypeScript-first on ADK-JS. The design lives in
[RFC-001](docs/rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md). The dev
environment is a single GCP project, described in
[infra/terraform/DESIGN.md](infra/terraform/DESIGN.md).

Status: pilot. Everything runs offline against in-repo fakes. Nothing is deployed to
a live dev URL yet; issue #24 is held until real adapters (database, Directory, Drive,
model) replace the fakes.

## Local development

`docker compose up` starts the web app, API, Postgres and the fakes with your own
Application Default Credentials. See
[docs/runbooks/local-development.md](docs/runbooks/local-development.md). `pnpm dev:up`
starts the fake-only stack that CI e2e uses.

## Getting Started

### Prerequisites

- [pnpm](https://pnpm.io/) **11.x** (see `packageManager` in `package.json`; use [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)
- Node.js **22+** (see `engines` in `package.json`; `.node-version` pins the version used for local dev and CI)

Dependency installs follow pnpm 11 supply-chain settings in [`pnpm-workspace.yaml`](pnpm-workspace.yaml): **minimum release age** (this repository uses a **7-day** quarantine, stricter than pnpm’s built-in 24-hour default), **blocking exotic transitive dependencies**, and an **`allowBuilds`** allowlist for packages that run install scripts. See [pnpm 11 release notes](https://pnpm.io/blog/releases/11.0) and [Supply-chain defaults (Socket)](https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults).

Linting and formatting use [Trunk](https://trunk.io/) (ESLint, Prettier, and more). The Trunk **launcher** is installed with project dependencies—you do not need a separate Trunk install for the default workflow.

### Installation

```bash
pnpm install
```

Optional: prefetch Trunk’s hermetic tools (helpful for offline work or CI images):

```bash
pnpm exec trunk install
```

If you prefer a global `trunk` on your PATH, see the [Trunk installation guide](https://docs.trunk.io/references/cli/getting-started/install) (e.g. `brew install trunk-io` on macOS).

### Supply-chain protections

This repository uses **pnpm 11** with settings in [`pnpm-workspace.yaml`](pnpm-workspace.yaml): a **7-day** [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) (10080 minutes, stricter than pnpm’s default 1 day), [`blockExoticSubdeps`](https://pnpm.io/settings#blockexoticsubdeps) enabled, and an [`allowBuilds`](https://pnpm.io/settings#allowbuilds) map for dependencies that must run install scripts (pnpm 11 requires this for native toolchain packages such as esbuild). See the [pnpm 11 release notes](https://pnpm.io/blog/releases/11.0).

CI: pull requests and `main` run `pnpm lint:security` then generate/scan an SPDX SBOM (`.github/workflows/sbom.yml`). Publish re-checks `pnpm lint:security` before npm publish.

### Build

```bash
pnpm build
```

### Test

```bash
pnpm test
```

### Linting & Formatting

```bash
pnpm lint
pnpm format
```

## Project Structure

- `apps/api/`: backend (RFC-001's `bff`).
- `apps/web/`: web app.
- `packages/domain/`, `packages/api-contract/`, `packages/policy/`, `packages/fakes/`, `packages/cli/`: domain types, generated API contract, policy engine, in-repo fakes and the `aw` CLI.
- `packages/common/`: leftover template package; remove it when nothing needs it.
- `agents/skills/`: agent skills. `contracts/`, `schemas/` and `fixtures/` hold shared schemas and test fixtures.
- `e2e/`: contract, security, adversarial, web and dev-environment tests. `evals/` holds evals.
- `infra/terraform/`: Terraform for the dev project: `bootstrap/`, `identity/dev/`, `environments/dev/` and shared `modules/`. See [DESIGN.md](infra/terraform/DESIGN.md) and the [bootstrap runbook](docs/runbooks/terraform-bootstrap.md).
- `docs/`: ADRs, RFCs, runbooks, security controls and probe write-ups (`docs/spikes/`). `spikes/` and `tools/` hold the probe harnesses and operational tooling.

[ADR 0002](docs/adr/0002-monorepo-layout.md) records the layout decision.

## Architecture decisions

The index is [docs/adr/README.md](docs/adr/README.md).
[ADR 0001](docs/adr/0001-typescript-first-with-adk-js.md) is the language decision.
[ADR 0002](docs/adr/0002-monorepo-layout.md) is the layout decision.

## License

Apache-2.0. See [LICENSE](LICENSE).

# 2. Monorepo layout

Date: 2026-10-10

## Status

Accepted

## Context

RFC-001 section 14.3 draws `apps/web`, `apps/bff`, `services/`, `agents/`, `connectors/`, `contracts/`, `infra/terraform`, `policies/`, `runbooks/`, and `docs/adr/`. This repository uses a smaller layout. The tree today is the template, with one package at `packages/common`.

## Decision

The repository layout is `apps/web`, `apps/api`, `packages/domain`, `packages/policy`, `packages/fakes`, `packages/cli`, `e2e/`, `infra/`, and `docs/`.

`apps/api` is the backend that RFC-001 calls `apps/bff`. Domain types, policy, fakes, and the CLI are packages under `packages/`. End-to-end tests live in `e2e/`. Cloud definitions live in `infra/`. Records such as this one live in `docs/`.

This record does not create those directories and does not move `packages/common`.

## Consequences

A new app or package goes in one of the directories named above.

`pnpm-workspace.yaml` still includes only `packages/*`. A later change adds `apps/*` when those apps exist.

`packages/common` stays until a later change replaces it.

Readers of RFC-001 section 14.3 follow this record when the two layouts differ.

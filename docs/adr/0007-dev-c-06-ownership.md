# 7. Dev C-06 ownership

Date: 2026-11-24

## Status

Proposed

## Context

[ADR 0003](0003-pilot-decisions.md) says Yu owns the pilot through C-05, that named owners are required before C-06, and that no human user is bound in infrastructure until those owners exist. C-06 (issue #24) deploys the `dev` project behind IAP and runs the `e2e/dev` suite against it. The workflow, the e2e specs and the Terraform for it exist. The step is blocked on an owner, not on code.

The `dev` project holds test-tenant data only. Production stage gates still need owners for security, platform and product sign-off, as listed in `docs/plans/enterprise-production-v1/ops-05/go-no-go-form.md`.

## Decision

This record supersedes the **Ownership** clause of ADR 0003 and nothing else. Region, test tenant, retrieval arm, first write target and spend in ADR 0003 stay Accepted.

Yu Ishikawa is the sole named owner and operator for C-06 in the `dev` project. That covers the operator actions in `docs/runbooks/deploy-dev.md`, including binding the test-tenant identities the runbook lists in the `dev` IAP allowlist.

Outside C-06, no human user is bound in infrastructure until named owners exist, as ADR 0003 required.

Named production owners are still required before G2.

## Consequences

- C-06 can run without waiting for more owners.
- One person does both the C-06 work and its operator sign-off. This is accepted because `dev` holds no real data.
- This record grants nothing outside the `dev` project and nothing beyond C-06. Later `dev` work that binds more human users needs named owners or a new record.
- This record does not change the approvers any stage gate requires. `docs/plans/enterprise-production-v1/ops-05/go-no-go-form.md` still lists them, G1 included.
- G2 stays blocked until named production owners exist.
- On Accept, link this record to ADR 0003 as an amendment (`adr link 7 Amends 3 "Amended by"`), not through `create-adr.sh --proposes 3`, which would mark all of ADR 0003 Superseded.

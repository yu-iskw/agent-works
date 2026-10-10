# 3. Pilot decisions

Date: 2026-10-10

## Status

Accepted

## Context

The operator answered the six Appendix F questions on 2026-10-11 and made the answers binding. This file is repository record 0003. It is not the RFC section 3 note labeled ADR-003. C-05 writes records 0004 and 0005.

## Decision

**Region.** The pilot runs in `asia-northeast1`. The inference location is checked in C-02 (issue 20). The Terraform provider region in `infra/terraform/environments/dev/providers.tf` carries this answer.

**Ownership.** Yu owns the pilot through C-05. Named owners are required before C-06. No human user is bound in infrastructure until those owners exist.

**Test tenant.** The pilot uses a separate test tenant or organizational unit with Alice, Bob, and a reviewer group. The users and the group are described as data in `infra/terraform/environments/dev/tenant.tf`. Nothing creates Workspace users.

**Retrieval arm.** Arm B runs only if there is no Gemini Enterprise trial. No retrieval is built under this record.

**First write target.** The first real write is a Google Docs draft in a shared drive. The fake ticket tool stays for CI. No write tool is built under this record.

**Spend.** There is no spending cap. Spend is tracked and nothing more. A budget may alert. It must not disable billing or set a hard stop. The dev stack declares no budget notification channel that automation can read, and the plan test `budget-alerts-only` fails if one appears.

## Consequences

The infra-check job keeps the Spend answer true. A Pub/Sub topic wired to the budget fails the job.

RFC-001 section 17.2 hard stops do not apply to the dev project. A later record changes that, not this one.

C-05 records its two decisions in 0004 and 0005 and cites the Retrieval arm rule above.

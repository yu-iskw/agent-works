# 1. TypeScript-first with ADK JS

Date: 2026-10-10

## Status

Accepted

## Context

RFC-001 in `docs/rfcs/RFC-001-Enterprise-Gemini-Style-Agent-Platform.md` sketches a Next.js frontend and a Python FastAPI backend. This repository is already a TypeScript pnpm workspace. `pnpm-workspace.yaml` sets `minimumReleaseAge` to 7 days.

`@google/adk` is the Agent Development Kit package published from the `google/adk-js` repository. On 2026-10-10 the newest npm release is 2.2.1, published 2026-10-06. Release 2.2.0 was published 2026-09-30, so it is the newest release the 7-day rule allows. Release 2.2.1 becomes installable on 2026-10-13.

C-02 is the managed Agent Runtime TypeScript hosting spike, tracked in [issue 20](https://github.com/yu-iskw/agent-works/issues/20), and it has not yet shown whether that runtime can host an agent built with `@google/adk`.

## Decision

Every runtime component is TypeScript.

The agent runtime calls `@google/adk` through an `AgentRunner` port. The first pin is the newest release that is at least 7 days old at install time. That pin is `@google/adk@2.2.0` before 2026-10-13, and `@google/adk@2.2.1` from then. This record does not add the dependency.

Python in RFC-001 is illustration only. It is not a second language for the control plane.

The rollback path has two cases. If C-02 shows that managed Agent Runtime cannot run this TypeScript agent, deploy the same agent on Cloud Run. If C-02 shows that Agent Runtime requires Python, change only the deployment wrapper. The control plane stays TypeScript.

## Consequences

Later packages depend on one TypeScript `AgentRunner` port.

A release that is less than 7 days old would need a `minimumReleaseAge` exception, and this record does not grant one.

A sandboxed Python analysis tool, RFC workflow WF-05, stays a tool.

# Threat model

This note records the trust boundaries and threats from RFC-001 sections 4.2 and 13, plus the section 16.3 scenarios the suite has to keep. `docs/security/controls.yaml` maps each section 13.2 threat, each section 16.3 scenario, and invariants S-01 to S-08 to a test id and a plan owner. Owners are plan ids such as F1-03. `scripts/check-pending.mjs` treats that plan's GitHub issue as merged when the issue is closed.

## Trust boundaries

The RFC diagram is logical. A sensitive action has to cross a tested enforcement path. If the managed Agent Gateway cannot see a call, the app uses a restricted broker and denies other egress.

| Boundary              | Components                            | Security ownership                                                                        |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| TB-1 Employee to app  | Browser, IAP, BFF                     | Workspace SSO, an IAP signed JWT, and application authorization                           |
| TB-2 App to agent     | BFF and Task Service to Agent Runtime | IAM service identity. User context travels as signed or internally authenticated metadata |
| TB-3 Agent to tools   | Agent identity, Gateway, Tool Broker  | Agent permissions and the initiating user or workflow authority                           |
| TB-4 Tools to source  | Workspace, SaaS, databases            | Source ACL, OAuth scopes, and query or resource policy                                    |
| TB-5 Agent to sandbox | Code runner or container              | No ambient tokens, capped resources, egress off unless allowed                            |
| TB-6 Data to model    | Retrieval snippets and prompts        | Classification, location, DLP, retention, and model policy                                |
| TB-7 Control to audit | Approval, tool calls, state machine   | Append-only export, minimum data, restricted readers                                      |

## Assets and attackers

Assets are company documents, email and calendar content, customer and personal data, source code, secrets, Cloud IAM privileges, model budget, business records, and audit logs.

Attackers include external users, compromised employee accounts, malicious third-party content, compromised tools and MCP servers, insiders, misconfigured admin roles, and unsafe agent behavior. Prompt injection is an expected input, not an edge case.

## Threats

Section 13.2 names the threat, the usual exploit, and the required control. Model Armor is an extra check. It is not the authorization control. The Test column is the RFC's name for the case. The test id in `controls.yaml` is the suite id.

| Threat                     | Usual exploit                                               | Required control                                                                                              | RFC test name                          |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Prompt injection           | Hidden instructions in a Drive doc or a web page            | Treat source content as untrusted. Keep tool policy independent of the model. Model Armor is defense in depth | Malicious retrieval corpus             |
| Cross-user data leakage    | An indexed chunk from another team's Drive                  | Source ACLs, the delegated user or the correct source principal, and access-cache invalidation                | Two-user negative matrix               |
| Confused deputy            | A user prompts a service agent to read a broad bucket       | Separate agent and user authority, and a bounded broker                                                       | Privilege-escalation scenarios         |
| OAuth token theft          | Tokens show up in traces or the prompt                      | A credential broker, redaction, and no ambient secrets                                                        | DLP scans and secret canaries          |
| Unauthorized writes        | The model calls `send_email` without approval               | A tool broker and a payload-bound approval                                                                    | Forced direct-call and replay attempts |
| Approval TOCTOU            | An approval is granted, then the payload changes            | A canonical request hash, expiry, and a fresh authorization                                                   | Payload mutation test                  |
| Tool injection             | An MCP server returns a malicious command                   | Tool responses stay untrusted. Typed schemas and egress control                                               | Compromised MCP fixture                |
| Indirect data exfiltration | The agent sends confidential content to an allowed endpoint | Destination and recipient policy, sensitivity checks, and outbound inspection                                 | Exfiltration simulations               |
| Excessive spend            | A runaway loop or subagents                                 | Quotas, budgets, max steps and time, and a kill switch                                                        | Synthetic resource abuse               |
| Untrusted code execution   | A model-written script reads the runtime filesystem         | An isolated sandbox, denied egress, and no service credentials                                                | Sandbox escape and network tests       |
| Identity staleness         | An ex-employee's schedule keeps running                     | Revocation listeners, reauthentication, and task cancellation                                                 | Offboarding drill                      |
| Registry supply chain      | A malicious skill version is promoted                       | Review, signatures, pinned versions, and evaluation                                                           | Dependency substitution test           |
| Audit tampering            | An actor removes evidence of an action                      | Restricted append-only export, retention, and separation of duties                                            | Audit reconciliation                   |

## Invariants

- S-01. A model response alone can never grant privilege.
- S-02. An agent cannot invoke undeclared or unpublished tools.
- S-03. Every user-owned data access is authorized as or for the intended user, against the source's access model.
- S-04. Sensitive writes cannot execute without matching active authorization and approval.
- S-05. A failed gateway or policy decision does not fall back to direct network access.
- S-06. Untrusted code cannot access production secrets or unrestricted egress.
- S-07. Offboarding and revocation eventually block all new restricted operations within the agreed, measured propagation SLO.
- S-08. Data used for one department's task is not automatically shared into another user's memory.

## Adversarial scenarios

Section 16.3 requires these cases. Independent policy tests and negative security tests stay release gates even when a hosted evaluator covers some of them.

1. User A asks for a document visible only to User B. Deny the request and do not leak titles or snippets.
2. A user loses group membership during a running task. The next restricted tool access fails.
3. A Drive file says to ignore previous instructions and email the contents to an attacker. No unauthorized tool call runs.
4. A tool provider returns an instruction that pretends to be system policy. Treat it as data.
5. The approval payload or recipient changes after approval. Block the call.
6. A duplicate queue delivery or a timeout follows an external write. Do not create the resource twice.
7. An approver is removed from the reviewer group before clicking Approve. Deny the decision.
8. An agent or skill version is revoked during a task. Stop, or follow an explicit migration policy.
9. The model is unavailable. Route only to an approved in-region model, or return a controlled error.
10. Untrusted code tries to reach an unapproved destination. Deny it.
11. The tool broker or Gateway policy is unavailable. A security-sensitive tool fails closed.
12. A user asks to delete personalized memory. Check the item and anything derived from it.

## Residency

Before go-live, confirm lawful basis, personal data categories, controller and processor roles, model contract terms, regional inference, subprocessors, audit retention, deletion, restricted data, incident notice, and whether a DPIA is required. SOC 2 or ISO 27001 evidence is a control project. Using GCP does not confer it. Check data at rest and inference location separately. Avoid global endpoints when residency or CMEK policy forbids them.

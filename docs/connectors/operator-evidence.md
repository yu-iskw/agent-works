# Operator evidence and production boundary

This bundle is offline. It does not establish consent for a real Workspace
tenant or complete the Gmail privacy assessment. It never contacts Google
production endpoints. Fake grants, seeded ACLs, and tests are development
evidence only.

Before any future tenant-enabled integration, operators must supply and review:

- D-07 real-tenant incremental OAuth consent evidence, including allowed scopes,
  consent-screen policy, revocation behavior, and subject ownership verification.
- The Gmail privacy assessment for read/draft data handling, allowed audiences,
  retention, data classification, and source-data treatment in model prompts.
- Approved Docs destinations and Calendar creation policy, including the absence
  of attendee notifications for this capability.
- An owned secret resolver that returns only caller-scoped tokens, without
  service-account fallback or token logging.
- Trusted policy callbacks and audit sinks, including appropriate subject/receipt
  retention and access controls.

Gmail bodies default to CONFIDENTIAL in the offline implementation. Production
assessment may require RESTRICTED or deny the capability entirely. A scope grant
is never a policy grant, and a human approval never grants additional ACL access.

Gmail send remains a separate EXTERNAL_SEND declaration under default deny.
Neither compose scope, a draft approval, nor an existing read grant enables it.
A future send capability requires separate scope, manifest, policy, approval,
operator evidence, and implementation review. This bundle contains no send path.

# Cost model and capacity inputs

## Units and approval

The table in `tools/finops/fixtures/traffic.json` is a **PLACEHOLDER** price table.
It contains no vendor quote. Currency is a fixture display unit. All calculations
return integer micro-units with explicit rounding per component. Estimates are not
invoices and do not include unmeasured contractual charges.

No amount or capacity output authorizes a cap. ADR 0003 leaves dev spend tracked
only. D-08 and D-10 remain unresolved, and deletion, dev hard stops and real restores
remain unauthorized.

## RFC-001 §17.1 mapping

| Input or charge                 | Formula / purpose                                                               |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Submitted tasks                 | Daily active users × tasks/user/day × days                                      |
| Completed tasks                 | Submitted × completion ratio                                                    |
| Accepted results                | Completed × acceptance ratio; acceptance here means accepted result quality     |
| Model input                     | Turns × input tokens × uncached fraction × placeholder input price              |
| Output                          | Turns × output tokens × placeholder output price                                |
| Cache                           | Turns × input tokens × cache fraction × placeholder cache price                 |
| Grounding                       | Submitted × grounding calls/task × placeholder call price                       |
| Runtime and sandbox             | Submitted × runtime seconds × placeholder compute price                         |
| Search                          | Submitted × retrieval ratio × tool calls/task × placeholder search price        |
| Index/ingestion                 | Index size × daily churn ratio × days × placeholder ingestion price             |
| Orchestration                   | Submitted × placeholder orchestration/task charge                               |
| SQL/storage/KMS/logging         | Submitted × combined placeholder charge/task                                    |
| Artifacts                       | Submitted × artifact volume/task × placeholder artifact storage price           |
| Network                         | Submitted × regional egress/task × placeholder egress price                     |
| Third-party APIs                | Submitted × placeholder API/task charge                                         |
| Licensing                       | Active seats × placeholder monthly seat price × days/month normalization        |
| Security/observability          | Submitted × placeholder service/task charge                                     |
| Engineering/SRE/security review | Hours × role-specific placeholder hourly rate                                   |
| Approval labor                  | Submitted × approval ratio × approval minutes ÷ minutes/hour × placeholder rate |

Compute cost per completed and per accepted result from **direct plus labor** totals.
Both denominators remain visible. Zero results yields `null`, not an infinite value
or a misleading zero cost. Overflow and negative/non-finite fixture inputs fail.

## Capacity

Average arrival rate is submitted tasks divided by the fixture interval. Little's
law estimates mean concurrent jobs as arrival rate × mean runtime. Peak concurrency
is the ceiling of mean concurrency × placeholder peak factor. Model turns and tool
calls/second use the same peak factor. Index churn and artifact volume remain
separate capacity outputs.

This is a planning calculator, not a saturation prediction. It does not model rate
limit distributions, queueing tails, provider outage bursts, regional failover,
background scheduling or a contractual availability objective. Collect authorized
pilot measurements and business requirements before setting real limits.

## Estimate versus provider evidence

`reconcileProviderUsage` retains task ID, sponsor, estimate, independent provider
usage and variance. Duplicate task rows fail. An estimate/provider difference is an
investigation input, not permission to reset counters or change the source bill.
`showback` sums budget audit evidence using event identity, ignoring exact redelivery
and rejecting conflicting identities. Integer micro-units avoid floating-point
accumulation of fractional monetary amounts in the budget ledger.

## Configuration safety

Never replace fixture prices with copied current vendor quotes without recording
authorized provenance and approval elsewhere. This issue deliberately contains no
quotes, real budgets, production caps or destination names. The standalone tool
only prints its fixture report and never reads ambient environment variables.

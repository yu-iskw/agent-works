# Issue 135: reliability and FinOps prototype

All monetary amounts, caps, prices, SLO targets, retention and the SIEM destination
are **UNAPPROVED PLACEHOLDERS**. The current dev project remains observe-only under
[ADR 0003](../adr/0003-pilot-decisions.md). No deletion, dev hard stop or real restore
is authorized by this change; D-08 and D-10 remain unresolved.

## Components

| Component                  | Integration seam                                                          | Evidence                                                                       |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Error taxonomy and retries | Domain subpaths `error-class` and `error-class-retry`; API `retryAdapter` | Permanent/policy refusal, transient retry, seeded fast-check storm property    |
| L3 budgets                 | `BudgetPort`, `budgetGuard`, memory/Postgres ports                        | Task/user cost, steps, concurrency, controlled error and audit evidence        |
| L6 showback                | `showback`, `reconcileProviderUsage`                                      | Deduplicated sponsor totals and independent provider variance                  |
| Cost/capacity              | `costReport`, `tools/finops/report.mjs`, `aw finops`                      | Full accepted-result cost and deterministic snapshot                           |
| SLO telemetry              | `structuredEvent`, `sloReport`, `tools/slo/report.mjs`                    | Protected RFC fields, latency percentiles, receipts and duplication snapshot   |
| SIEM                       | Dedicated `audit/siem-export` sink and reconciliation ports               | Immutable redacted chain, token/prompt canaries, missing receipt failure       |
| DLQ                        | `DlqStore`, `createDlqService`, `aw dlq`                                  | Original key, fenced explicit requeue, risky compensation evidence             |
| Restore                    | `runRestoreDrill`, `tools/restore-drill/run.mjs`                          | Actual disposable Postgres dump/restore and independent external create counts |

## Usage

```bash
pnpm build
node packages/cli/dist/aw.js finops report --fixture tools/finops/fixtures/traffic.json
node tools/slo/report.mjs tools/slo/fixtures/events.jsonl tools/slo/fixtures/targets.json
node tools/restore-drill/run.mjs tools/restore-drill/fixtures/request.json
```

The tools are repository-local and consume compiled API modules. Build before using
them. Domain subpath exports avoid editing the shared domain barrel. Knip entries
identify public opt-in integration seams, rather than pretending those ports are
already wired into application routes. No adapter, task route, exporter, trace,
policy, cancellation, suspension, release-gate or adversarial-eval implementation is
changed. The current checkout contains migrations 0001–0008; this issue reserves
0011 without inventing missing bundle migrations.

## Operational boundaries

L3 enforcement is exercised only in `isolated-test-enforce`; normal dev usage supplies
`observe`. Application-local admission is an estimate and does not promise zero
provider overspend. Policy configuration is a trusted integration input, not a value
an end user can choose. L5 suspension and the org/project control hierarchy remain
with their separately owned control interfaces.

The file SIEM sink is a local immutable-append prototype with hash-chain mutation
checking. It is not a production WORM product, remote SIEM destination, retention
policy or RBAC deployment. Detailed IDs are protected by keyed HMAC. Choose and
protect a real redaction key only after governance approves the export procedure.

DLQ integration requires trusted risk classification and live dispatch fencing. CLI
operations are restricted to marked local disposable databases, preserving current
readiness gates. A production control-plane integration requires separately approved
operator authorization. Compensation records external evidence and never executes
an inverse write automatically.

See [cost model](cost-model.md), [integration](integration.md), and the four runbooks
for exact semantics and remaining gates.

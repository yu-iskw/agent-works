# Runaway spending: offline pilot procedure

## Authority and gates

This runbook implements RFC-001 §19.1 investigation and §17.2 L3/L6 prototype evidence.
All amounts, prices, application caps, alert thresholds and retention are **UNAPPROVED
PLACEHOLDERS**. They are fixture inputs, not operational limits. No real prices are
quoted and no spending approval is recorded here.

**Deletion, dev hard stops and real restores are not authorized.** D-08 withholds audit
retention/deletion approval; D-10 withholds workload and availability decisions;
[ADR 0003](../adr/0003-pilot-decisions.md) requires spend tracking only for dev.
Do not disable billing, freeze dev execution, install a numeric dev cap, read a budget
notification as permission to stop work, or delete evidence. This runbook does not
resolve D-04, D-09, or D-10. A later accepted record must name a different project and
the allowed RFC §17.2 control before a hard stop can be exercised there.

## Recognize and collect

1. Identify the task sponsor, task ID, inference version and observation window using
   protected operator evidence. Restrict detailed evidence to dedicated audit access.
2. Compare stored estimates with the independent provider usage export for the same
   tagged task. Preserve the variance rather than relabeling estimates as billed cost.
3. Examine retry counts, shared retry pool consumption, deadline exits, inference
   steps and concurrency. A finite retry pool must be shared across affected clients;
   a fresh pool on each retry defeats the storm control.
4. Check whether one operation ID has been replayed, whether an estimate was counted
   more than once, and whether user totals include every task in the same window.
5. Reconcile the sum of budget event amounts to sponsor showback. A controlled denial
   has a zero charge in enforcement fixtures; an observe-mode overrun remains charged.

## Offline evidence commands

Build first with `pnpm build`, then run:

```bash
node packages/cli/dist/aw.js finops report --fixture tools/finops/fixtures/traffic.json
node tools/finops/report.mjs tools/finops/fixtures/traffic.json
```

These commands use a **PLACEHOLDER** price table and synthetic fixture traffic. The
output includes direct variable costs, engineering/SRE/security/approval labor,
capacity estimates, and separate completed and accepted-result denominators.
A null denominator means there were no results of that kind; it is not free service.

## Response within current authority

For dev, record the overrun and notify the authorized owner through the established
human incident process. This document does not authorize automated messages.
The budget guard remains `observe`. A local `isolated-test-enforce` guard may be
exercised only against disposable fixtures and fake adapters.

The L5 high-cost agent/skill suspension interface is owned by the separate control
bundle. Record the affected version and evidence for that owner; this change does not
implement a suspension, kill switch, new schedule or global-agent-stop action.
No action named in RFC §19.1 overrides ADR 0003 for dev.

## Close

Preserve the fixture report, protected task evidence, independent usage row, estimate
variance and retry investigation. Record which decisions remain open. Do not change
retention, delete audit artifacts or assert that cloud alert latency guarantees a
zero-overspend outcome. Passing a prototype test does not pass P3-FIN's live gate.

# AGT-07 evidence: dependency and execution status UI

Base: origin/epv1/integration. All results local (Postgres via Docker, Chromium offline). Nothing live. Not VALIDATED.

## Acceptance mapping

| Criterion                                                                     | Test                                                                                                                                                                                                                              | Result |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Server-authoritative revision, states, reasons, retry, approval, result links | `apps/api/src/teamwork/projection-route.test.ts` "shows a proposed revision...", "reports retry time, approval needs..."                                                                                                          | PASS   |
| Inaccessible node omitted, no count, canary absent (response)                 | same file, "omits an inaccessible node and every trace of it" (real Postgres; canary in name, deliverable, brief, error)                                                                                                          | PASS   |
| Canary absent from the DOM                                                    | `e2e/ui/graph-status/graph-status.spec.ts` "private data is absent from the DOM" (hostile upstream adds fields; graph and table views)                                                                                            | PASS   |
| Keyboard navigation                                                           | `graph-model.test.ts` "keyboard navigation"; spec "keyboard navigation moves focus along dependencies" (Arrow keys, Home, End, table toggle by Enter)                                                                             | PASS   |
| Accessible list/table fallback, axe                                           | spec same test: table view plus axe wcag2a/2aa/21aa, zero violations                                                                                                                                                              | PASS   |
| Out-of-order, duplicate events and reconnect converge                         | `graph-model.test.ts` "holdProjection", "graph sync" (all orderings end on the newest revision); spec "out-of-order replies and a lost connection"                                                                                | PASS   |
| Stale-revision mutation cannot duplicate or overwrite                         | `projection-route.test.ts` "graph mutations are compare-and-swap": stale approve writes nothing; 6 concurrent approves dispatch once; 4 concurrent cancels cancel once; wrong digest and wrong revision refused; other member 404 | PASS   |
| UI shows conflict and refreshes                                               | spec "a refused stale cancel shows the conflict, refreshes and is not retried"                                                                                                                                                    | PASS   |

## Commands

| Command                                                                                                                             | Exit                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `pnpm build`                                                                                                                        | 0                    |
| `pnpm typecheck`                                                                                                                    | 0                    |
| `pnpm --filter @agent-works/api exec vitest run src/teamwork/projection-route.test.ts` (8 tests, real Postgres)                     | 0                    |
| `pnpm --filter @agent-works/web exec vitest run` (472 tests)                                                                        | 0                    |
| `node e2e/ui/graph-status/build-harness.mjs` then `pnpm exec playwright test -c e2e/ui/graph-status/playwright.config.ts` (4 tests) | 0                    |
| `pnpm knip`                                                                                                                         | 0                    |
| eslint on touched files                                                                                                             | 0 issues after fixes |

Screenshots (offline harness, real component): `screenshots/graph.png`, `table.png`, `conflict.png`.

## Design

- `GET /v1/teamwork/tasks/:id/graph` returns `{ projection, taskVersion }`; `projection` is null before a live plan exists. The route selects only key, deliverable, status, attempt, error code, dependencies, retry time, update time and `output is not null`. Briefs, outputs, questions and error text are never read. The result is parsed with the strict `graphProjectionSchema`.
- A node is accessible when its teammate is owned by the caller. Inaccessible nodes go through `visibleNodes`: no placeholder, no count, and no remaining node names them as a prerequisite.
- `POST .../graph/cancel` and `.../graph/approve` take `graphMutationSchema`. The task row is locked, `assertGraphCas` runs against the live plan, and `cancelTask`/`decidePlan` run in the same transaction (the open transaction stands in for `deps.sql.begin`). A stale caller gets a 409 with `stale_revision`, `digest_mismatch` or `not_live`; a repeat gets the existing `cannot_cancel_*`/`not_in_plan_review` refusal.
- The web view holds a projection only through `isNewerProjection`, polls while visible, and refetches the whole graph on `online` and `visibilitychange`.

## Limits and residual risks

- The existing `pnpm ui:e2e` stack needs the real Vertex model and Docker ADC, so it was not run. The offline Playwright harness replaces it for DOM evidence; a spec against the real stack is UNTESTED and not written.
- `taskVersion` in a mutation is validated but orders display only; the CAS is revision plus digest. A cancel is therefore not refused because node states moved within the same revision.
- Accessibility rule is teammate ownership. Shared bots (AGT-04 catalog sharing) need the rule widened with a negative test.
- The graph view has no SVG edges; dependencies are shown as layers and "After" text.
- No push-based events exist; convergence is poll plus reconnect refetch.

## Wiring the coordinator must do

- Spread `projectionRoutes()` (from `apps/api/src/teamwork/projection-route.ts`) into the table in `createRoutes` in `routes.ts`. Auth, membership and the CSRF header are already enforced there. The `ProjectionRoute` type matches `Entry`.
- No migration. Rollback: remove the route spread; the web calls then 404 and the view shows "Connection lost".
- Edits outside the brief's write set, all minimal: `apps/web/app/workspace/routes.ts` (spread `GRAPH_ROUTES`), `task-routes.ts` (widen a `Pick`), `apps/web/app/m1/api.ts` (`graph`, `graphCommand`), `apps/web/vitest.config.ts` (domain alias), `apps/web/client/workspace/ui/panel/task-panel.tsx` (mount `<GraphStatus>`), `knip.json` (two e2e entries).

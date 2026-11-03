import { authorizeScope } from './access.js';
import { aggregate } from './aggregate.js';
import { reconcileDashboard } from './reconcile.js';

import type { BillingSource } from './aggregate.js';
import type { Reconciliation } from './reconcile.js';
import type { OpsDashboard, OpsPrincipal, OpsScope, OpsWindow } from './types.js';
import type postgres from 'postgres';

const DAY_MS = 86_400_000;

export type OpsDashboardService = {
  view(
    principal: OpsPrincipal,
    scope?: OpsScope,
    window?: Partial<OpsWindow>,
  ): Promise<OpsDashboard>;
  reconcile(
    principal: OpsPrincipal,
    scope?: OpsScope,
    window?: Partial<OpsWindow>,
  ): Promise<{ view: OpsDashboard; reconciliation: Reconciliation }>;
};

export function createOpsDashboard(options: {
  readonly sql: postgres.Sql;
  readonly now: () => Date;
  readonly billing?: BillingSource;
}): OpsDashboardService {
  async function view(
    principal: OpsPrincipal,
    requested?: OpsScope,
    partial: Partial<OpsWindow> = {},
  ) {
    const scope = authorizeScope(principal, requested);
    const now = options.now();
    const window: OpsWindow = {
      from: partial.from ?? new Date(now.getTime() - DAY_MS).toISOString(),
      to: partial.to ?? now.toISOString(),
    };
    return aggregate(options.sql, scope, window, now.toISOString(), options.billing);
  }
  return {
    view,
    async reconcile(principal, requested, partial) {
      const dashboard = await view(principal, requested, partial);
      return { view: dashboard, reconciliation: await reconcileDashboard(options.sql, dashboard) };
    },
  };
}

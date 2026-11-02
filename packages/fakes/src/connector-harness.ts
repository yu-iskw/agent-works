import type { ConnectorRegistry } from '@agent-works/domain/connector-cdk';

export type HarnessHandler = (input: unknown) => unknown | Promise<unknown>;

export type ConnectorHarness = {
  readonly registry: ConnectorRegistry<HarnessHandler>;
  /** Every call that reached a handler, in order; a denied call never appears here. */
  readonly calls: readonly { readonly tool: string; readonly input: unknown }[];
  invoke(tool: string, input: unknown): Promise<unknown>;
};

/**
 * Offline stand-in for a connector host. It wraps a registry built by `defineConnector` so each
 * handler records its call; an unknown tool fails closed before any handler runs.
 */
export function createConnectorHarness(
  registry: ConnectorRegistry<HarnessHandler>,
): ConnectorHarness {
  const calls: { tool: string; input: unknown }[] = [];
  const recording: ConnectorRegistry<HarnessHandler> = new Map(
    [...registry].map(([tool, entry]) => [
      tool,
      {
        manifest: entry.manifest,
        handler: (input: unknown) => {
          calls.push({ tool, input });
          return entry.handler(input);
        },
      },
    ]),
  );
  return {
    registry: recording,
    calls,
    async invoke(tool, input) {
      const entry = recording.get(tool);
      if (!entry) throw new Error(`unknown tool ${tool}`);
      return entry.handler(input);
    },
  };
}

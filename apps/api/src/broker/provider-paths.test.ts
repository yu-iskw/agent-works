import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Every way production code can reach an external provider, and the only files allowed to open
// it. Each allowed file sits behind a broker: a new call site anywhere else fails this test.
// Matching is textual, so an aliased or reshaped call (a destructured `postTicket`, a path held in
// a constant) is not seen; review still owns those.

const src = fileURLToPath(new URL('../', import.meta.url));

const testSupport =
  /(\.test\.ts|\.bench\.ts|\/test-fixtures\.ts|\/broker-harness\.ts|\/test-authority\.ts|\/graph-test-support\.ts)$|^testing\//;

type Entrance = {
  readonly provider: string;
  readonly reaches: (source: string) => boolean;
  readonly allowed: readonly string[];
};

/** A call, not the declaration: `function name(` does not count. */
const calls = (pattern: RegExp) => (source: string) =>
  [...source.matchAll(pattern)].some(
    (match) => !source.slice(0, match.index).endsWith('function '),
  );

const entrances: readonly Entrance[] = [
  {
    provider: 'ticket provider, called only after authority, policy and approval revalidate',
    reaches: calls(/\bdeps\.postTicket\(/g),
    allowed: ['broker/broker.ts'],
  },
  {
    provider: 'ticket provider write, bound as the broker postTicket dependency',
    reaches: (source) => source.includes("'/tickets'") && source.includes("method: 'POST'"),
    allowed: ['skills/incident.ts'],
  },
  {
    provider: 'Google Workspace HTTP, handed only to createWorkspaceBroker',
    reaches: calls(/\bcreateGoogleHttp\(/g),
    allowed: ['connectors/runtime.ts'],
  },
  {
    provider: 'Docs, Calendar and Gmail adapters, handed only to createWorkspaceBroker',
    reaches: calls(/\bcreate(?:Docs|Calendar|Gmail)Adapter\(/g),
    allowed: ['connectors/runtime.ts'],
  },
  {
    provider: 'marketplace MCP tools (#185/#189), opened per call by the segment gateway',
    reaches: calls(/\bconnectMcp\(/g),
    allowed: ['teamwork/gateway.ts'],
  },
  {
    provider: 'MCP HTTP transport for approved external agents',
    reaches: calls(/\bmcpHttpTransport\(/g),
    allowed: ['teamwork/mcp-task/client.ts'],
  },
  {
    // Exception: bot delegation is not broker-mediated. It reaches only registry-approved agents
    // and re-runs its own recheck before every dispatch (bots/execution/external.ts).
    provider: 'external agent tasks for bot delegation',
    reaches: calls(/\bconnectAgentTask\(/g),
    allowed: ['teamwork/bots/execution/external.ts'],
  },
];

function productionSources(): ReadonlyMap<string, string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- src is this package's own source root
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.ts') && !testSupport.test(file));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from readdirSync of src
  return new Map(files.map((file) => [file, readFileSync(`${src}${file}`, 'utf8')]));
}

describe('provider paths', () => {
  const sources = productionSources();

  it.each(entrances)('$provider: reached only from $allowed', ({ reaches, allowed }) => {
    const found = [...sources].filter(([, source]) => reaches(source)).map(([file]) => file);
    expect(found.sort()).toEqual([...allowed].sort());
  });
});

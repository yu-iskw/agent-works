import * as z from 'zod';

import { approvedAgentSchema } from './contract.js';

import type { AgentRegistry, ApprovedAgent } from './contract.js';

/** The error contains field paths only, never configuration values or Zod's messages. */
export function parseAgentRegistry(json: unknown, opts: { allowLoopback: boolean }): AgentRegistry {
  const parsed = z.array(approvedAgentSchema).safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      return issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [path, key].filter(Boolean).join('.')).join(', ')
        : path || 'registry';
    });
    throw new Error(`Invalid agent registry fields: ${[...new Set(fields)].join(', ')}`);
  }
  const agents = new Map<string, ApprovedAgent>();
  for (const entry of parsed.data) {
    const url = new URL(entry.endpoint);
    const loopback = opts.allowLoopback && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
      throw new Error('Invalid agent registry fields: endpoint');
    if (!entry.allowedHosts.includes(url.host))
      throw new Error('Invalid agent registry fields: allowedHosts');
    if (agents.has(entry.agentId)) throw new Error('Invalid agent registry fields: agentId');
    Object.freeze(entry.supports);
    Object.freeze(entry.allowedHosts);
    agents.set(entry.agentId, Object.freeze(entry));
  }
  return Object.freeze({ get: (id: string) => agents.get(id), list: () => [...agents.values()] });
}

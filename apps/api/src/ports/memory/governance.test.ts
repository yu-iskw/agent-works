import { beforeEach } from 'vitest';

import { governanceContract } from '../governance.contract.js';

import { createMemoryGovernancePort } from './governance.js';

import type { GovernancePort } from '../governance.js';

let ports: GovernancePort[] = [];
beforeEach(() => {
  ports = [];
});
governanceContract(() => {
  const port = createMemoryGovernancePort();
  ports.push(port);
  return port;
});

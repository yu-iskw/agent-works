import { policyPortContract } from '../policy-port.contract.js';

import { createMemoryPolicyPort } from './policy-port.js';

policyPortContract(() => createMemoryPolicyPort());

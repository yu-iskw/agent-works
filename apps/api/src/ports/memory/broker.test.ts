import { brokerPortContract } from '../broker.contract.js';

import { createMemoryBrokerPort } from './broker.js';

brokerPortContract(() => createMemoryBrokerPort());

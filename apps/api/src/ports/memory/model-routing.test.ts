import { modelRoutingContract } from '../model-routing.contract.js';

import { createMemoryModelRoutingPort } from './model-routing.js';
modelRoutingContract(createMemoryModelRoutingPort);

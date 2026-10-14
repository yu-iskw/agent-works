import { delegationContract } from '../delegation.contract.js';

import { createMemoryDelegationPort } from './delegation.js';
delegationContract(createMemoryDelegationPort);

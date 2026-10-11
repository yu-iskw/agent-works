import { agentRunnerContract, runnerContractLimits } from '../agent-runner.contract.js';

import { createMemoryRunnerLimits } from './agent-runner.js';

agentRunnerContract(() => createMemoryRunnerLimits(runnerContractLimits));

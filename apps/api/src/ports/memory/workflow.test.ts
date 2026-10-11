import { workflowPortContract } from '../workflow.contract.js';

import { createMemoryWorkflowPort } from './workflow.js';

workflowPortContract(() => createMemoryWorkflowPort());

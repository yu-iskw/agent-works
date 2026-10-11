import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';

import { createLocalEngine } from './local-engine.js';
import { createMemoryWorkflowLog } from './workflow-log.js';

import type { LocalEngine } from './local-engine.js';
import type { LedgerPort } from '../ports/ledger-port.js';

type WorkflowRuntime = {
  readonly ledger: LedgerPort;
  readonly engine: LocalEngine;
};

function createWorkflowRuntime(): WorkflowRuntime {
  const ledger = createMemoryLedgerPort();
  return {
    ledger,
    engine: createLocalEngine({
      workflow: createMemoryWorkflowPort(),
      log: createMemoryWorkflowLog(),
      ledger,
    }),
  };
}

export const workflowRuntime = createWorkflowRuntime();

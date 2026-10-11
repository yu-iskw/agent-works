export type WorkflowReceipt = {
  readonly stepId: string;
  readonly body: string;
};

export type WorkflowLog = {
  put(taskId: string, stepId: string, body: string): Promise<'recorded' | 'present'>;
  list(taskId: string): Promise<readonly WorkflowReceipt[]>;
  bump(taskId: string, stepId: string): Promise<number>;
};

export function createMemoryWorkflowLog(): WorkflowLog {
  const receipts = new Map<string, WorkflowReceipt[]>();
  const attempts = new Map<string, number>();
  return {
    put(taskId, stepId, body) {
      const rows = receipts.get(taskId) ?? [];
      const existing = rows.find((row) => row.stepId === stepId);
      if (existing !== undefined) {
        if (existing.body !== body) return Promise.reject(new Error('receipt changed'));
        return Promise.resolve('present');
      }
      receipts.set(taskId, [...rows, { stepId, body }]);
      return Promise.resolve('recorded');
    },
    list(taskId) {
      return Promise.resolve(receipts.get(taskId) ?? []);
    },
    bump(taskId, stepId) {
      const key = attemptKey(taskId, stepId);
      const next = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, next);
      return Promise.resolve(next);
    },
  };
}

function attemptKey(taskId: string, stepId: string): string {
  return `${taskId}\0${stepId}`;
}

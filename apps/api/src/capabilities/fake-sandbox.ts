import type {
  ExecutionRequest,
  ExecutionResult,
  ProbeKind,
  SandboxPort,
} from './sandbox-contract.js';

/** A defect to inject. Each flaw makes one hostile probe succeed so the matrix must catch it. */
export type FakeFlaw = ProbeKind | 'leak-after-run';

const limitProbes: readonly ProbeKind[] = ['memory-bomb', 'cpu-spin', 'wall-hang'];

/** Deterministic in-process fake. It proves the harness logic only and says nothing about any real sandbox. */
export function createFakeSandbox(flaws: readonly FakeFlaw[] = []): SandboxPort {
  const held = new Map<string, number>();
  return {
    run(request: ExecutionRequest): Promise<ExecutionResult> {
      const flawed = flaws.includes(request.probe);
      held.set(request.executionId, flaws.includes('leak-after-run') ? 1 : 0);
      const limited = limitProbes.includes(request.probe) && !flawed;
      return Promise.resolve({
        executionId: request.executionId,
        status: limited ? 'killed-limit' : 'ok',
        exitCode: limited ? null : 0,
        artifacts:
          request.probe === 'emit-artifact'
            ? [
                {
                  name: 'out.bin',
                  sha256: 'a'.repeat(64),
                  bytes: 8,
                  mediaType: 'application/octet-stream',
                  scan: 'unscanned',
                },
              ]
            : [],
        breach: flawed && !limitProbes.includes(request.probe) && request.probe !== 'none',
      });
    },
    residue: (executionId) => Promise.resolve(held.get(executionId) ?? 0),
  };
}

import { requireCapability } from './gate.js';

import type { CapabilityGuard, GateContext } from './gate.js';

export type ExecutionLimits = {
  readonly cpuMs: number;
  readonly memoryBytes: number;
  readonly wallMs: number;
  readonly outputBytes: number;
};

/** What a hostile program attempts. Real adapters map each kind to one fixed, reviewed probe payload. */
export type ProbeKind =
  | 'none'
  | 'metadata-fetch'
  | 'credential-read'
  | 'egress-connect'
  | 'host-file-read'
  | 'memory-bomb'
  | 'cpu-spin'
  | 'wall-hang'
  | 'emit-artifact';

export type ExecutionRequest = {
  readonly executionId: string;
  readonly program: { readonly language: 'python' | 'javascript'; readonly source: string };
  readonly probe: ProbeKind;
  readonly limits: ExecutionLimits;
  /** Egress is denied unless a host is listed. The default is none. */
  readonly network: 'none' | { readonly allowHosts: readonly string[] };
};

export type ArtifactEntry = {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly scan: 'clean' | 'blocked' | 'unscanned';
};

export type ExecutionResult = {
  readonly executionId: string;
  readonly status: 'ok' | 'killed-limit' | 'error';
  readonly exitCode: number | null;
  readonly artifacts: readonly ArtifactEntry[];
  /** True when the attempted probe reached the protected resource. Any true value is a breach. */
  readonly breach: boolean;
};

export type SandboxPort = {
  run(this: void, request: ExecutionRequest): Promise<ExecutionResult>;
  /** Resources still held for an execution after it ended. Zero means cleanup completed. */
  residue(this: void, executionId: string): Promise<number>;
};

/** Only scanned-clean artifacts may leave the sandbox boundary. */
export function releasableArtifacts(result: ExecutionResult): readonly ArtifactEntry[] {
  return result.artifacts.filter((artifact) => artifact.scan === 'clean');
}

/**
 * The only entry point to execution. There is no worker fallback parameter by design:
 * a denial throws and nothing runs anywhere else.
 */
export function createGuardedSandbox(deps: {
  readonly guard: CapabilityGuard;
  readonly context: Omit<GateContext, 'capability'>;
  readonly sandbox: SandboxPort;
  readonly now: () => Date;
}): SandboxPort {
  const allow = (): void => {
    requireCapability(deps.guard, { ...deps.context, capability: 'sandboxExecution' }, deps.now());
  };
  return {
    run: async (request) => {
      allow();
      return deps.sandbox.run(request);
    },
    residue: async (executionId) => {
      allow();
      return deps.sandbox.residue(executionId);
    },
  };
}

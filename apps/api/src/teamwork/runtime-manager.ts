import type { ConnectorManifest } from '@agent-works/domain/connector-cdk';

/** Safe, closed set of reasons a runtime call can fail; only these ever reach `observed_detail`. */
type RuntimeErrorCode =
  | 'segment_mismatch'
  | 'invalid_name'
  | 'unknown_version'
  | 'digest_not_in_manifest'
  | 'runtime_unavailable'
  | 'deploy_failed'
  | 'quota_exceeded'
  | 'timeout';

export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode) {
    super(code);
    this.name = 'RuntimeError';
  }
}

type RuntimeRef = { readonly segment: string; readonly connector: string };
type RuntimeEnsure = RuntimeRef & {
  readonly version: string;
  readonly artifactDigest: string;
};
type RuntimeStatus = {
  readonly state: 'absent' | 'ready' | 'unhealthy';
  readonly resourceName: string;
  /** The identity the workload runs as; one per segment and connector, never shared. */
  readonly identity: string;
  readonly version: string | null;
  readonly artifactDigest: string | null;
};

/**
 * Port for running an out-of-process connector for one segment. `ensure` and `remove` are
 * idempotent, so a reconciler that crashed mid-call can simply call again.
 */
export type RuntimeManager = {
  ensure(request: RuntimeEnsure): Promise<RuntimeStatus>;
  remove(ref: RuntimeRef): Promise<void>;
  status(ref: RuntimeRef): Promise<RuntimeStatus>;
};

export type ManifestLookup = (id: string, version?: string) => ConnectorManifest | undefined;

/** Cloud Run service names are lowercase, start with a letter and stop at 49 characters. */
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,48}$/;

function resourceName(ref: RuntimeRef): string {
  const name = `aw-${ref.segment}-${ref.connector}`;
  if (!RESOURCE_NAME.test(name)) throw new RuntimeError('invalid_name');
  return name;
}

const identityFor = (name: string) => `${name}@fake.iam.invalid`;

/** The default when no real runtime is wired: every call fails closed instead of pretending to deploy. */
export const unavailableRuntimeManager: RuntimeManager = {
  ensure: () => Promise.reject(new RuntimeError('runtime_unavailable')),
  remove: () => Promise.reject(new RuntimeError('runtime_unavailable')),
  status: () => Promise.reject(new RuntimeError('runtime_unavailable')),
};

type Operation = 'ensure' | 'remove' | 'status';
type Service = { readonly version: string; readonly artifactDigest: string };

type FakeRuntimeManager = RuntimeManager & {
  /** Every call that reached the manager, in order, for assertions on what was and was not attempted. */
  readonly calls: readonly string[];
  /** Fails the next `times` matching calls (default 1) with `code`, before they change anything. */
  injectFailure(input: {
    readonly operation: Operation;
    readonly code: RuntimeErrorCode;
    readonly times?: number;
    readonly connector?: string;
  }): void;
  /** A deployed service reports `unhealthy` while set, like a revision that fails its health check. */
  setHealthy(connector: string, healthy: boolean): void;
};

/**
 * In-memory stand-in bound to one segment. It enforces what a real client must: a request for
 * another segment is refused, and a digest is deployed only if the manifest for that exact version
 * names it. Nothing is simulated beyond that, and no network or cloud call is made.
 */
export function createFakeRuntimeManager(options: {
  readonly segment: string;
  readonly manifest: ManifestLookup;
}): FakeRuntimeManager {
  const services = new Map<string, Service>();
  const unhealthy = new Set<string>();
  const failures: {
    operation: Operation;
    code: RuntimeErrorCode;
    times: number;
    connector?: string;
  }[] = [];
  const calls: string[] = [];

  const view = (ref: RuntimeRef): RuntimeStatus => {
    const name = resourceName(ref);
    const service = services.get(name);
    return {
      state:
        service === undefined ? 'absent' : unhealthy.has(ref.connector) ? 'unhealthy' : 'ready',
      resourceName: name,
      identity: identityFor(name),
      version: service?.version ?? null,
      artifactDigest: service?.artifactDigest ?? null,
    };
  };

  const guard = (operation: Operation, ref: RuntimeRef): void => {
    calls.push(`${operation}:${ref.segment}:${ref.connector}`);
    if (ref.segment !== options.segment) throw new RuntimeError('segment_mismatch');
    resourceName(ref);
    const failure = failures.find(
      (candidate) =>
        candidate.times > 0 &&
        candidate.operation === operation &&
        (candidate.connector === undefined || candidate.connector === ref.connector),
    );
    if (failure === undefined) return;
    failure.times -= 1;
    throw new RuntimeError(failure.code);
  };

  // A throw inside the callback becomes a rejection, as a real client's would.
  const attempt = <T>(callback: () => T): Promise<T> => Promise.resolve().then(callback);

  return {
    calls,
    ensure: (request) =>
      attempt(() => {
        guard('ensure', request);
        const manifest = options.manifest(request.connector, request.version);
        if (manifest === undefined) throw new RuntimeError('unknown_version');
        if (manifest.runtime?.artifactDigest !== request.artifactDigest)
          throw new RuntimeError('digest_not_in_manifest');
        services.set(resourceName(request), {
          version: request.version,
          artifactDigest: request.artifactDigest,
        });
        return view(request);
      }),
    remove: (ref) =>
      attempt(() => {
        guard('remove', ref);
        services.delete(resourceName(ref));
      }),
    status: (ref) =>
      attempt(() => {
        guard('status', ref);
        return view(ref);
      }),
    injectFailure: (input) => {
      failures.push({ ...input, times: input.times ?? 1 });
    },
    setHealthy: (connector, healthy) => {
      if (healthy) unhealthy.delete(connector);
      else unhealthy.add(connector);
    },
  };
}

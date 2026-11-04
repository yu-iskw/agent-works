import { defaultRetryConfig } from '../queue/cloud-tasks-config.js';

import type { WorkerBudget } from '../worker/types.js';

type Env = Readonly<Record<string, string | undefined>>;

type AdmissionWiring = {
  readonly leaseMs: number;
  readonly segmentId: string;
  readonly estimatedCostMicros: number;
  readonly sweepMs: number;
};
export type DeliveryWiring = {
  readonly workerUrl: string;
  readonly dispatcherEmails: readonly string[];
  readonly budget: WorkerBudget;
};
export type OutboxWiring = {
  readonly queue: {
    readonly projectId: string;
    readonly location: string;
    readonly queue: string;
    readonly workerUrl: string;
    readonly oidcServiceAccountEmail: string;
  };
  readonly owner: string;
  readonly leaseMs: number;
  readonly intervalMs: number;
  readonly batch: number;
  readonly maxAttempts: number;
};
type SweeperWiring = {
  readonly budget: WorkerBudget;
  readonly intervalMs: number;
  readonly redriveAfterMs: number;
  readonly maxRedrives: number;
  readonly limit: number;
};
type ExecutionWorkerWiring = { readonly budget: WorkerBudget; readonly intervalMs: number };

/** Every capability is absent unless its flag is exactly `on` and its required values are valid. */
export type Wiring = {
  readonly telemetry: boolean;
  readonly opsDashboard: boolean;
  readonly strictProposals: boolean;
  readonly admission?: AdmissionWiring;
  readonly delivery?: DeliveryWiring;
  readonly outbox?: OutboxWiring;
  readonly sweeper?: SweeperWiring;
  readonly executionWorker?: ExecutionWorkerWiring;
};

/** Names only, never values. */
export class WiringConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid wiring configuration: ${problems.join('; ')}`);
    this.name = 'WiringConfigError';
  }
}

const on = (env: Env, name: string): boolean =>
  Object.entries(env).some(([key, value]) => key === name && value === 'on');
const text = (env: Env, name: string): string | undefined =>
  Object.entries(env)
    .find(([key]) => key === name)?.[1]
    ?.trim() || undefined;

const REQUIRED = 'is required';

type Reader = {
  string(name: string): string;
  int(name: string, fallback?: number, min?: number): number;
  list(name: string): readonly string[];
};

function reader(env: Env, problems: string[]): Reader {
  const need = (name: string, why: string): never => {
    problems.push(`${name} ${why}`);
    return undefined as never;
  };
  return {
    string: (name) => text(env, name) ?? need(name, REQUIRED),
    list: (name) => {
      const value = text(env, name);
      return value === undefined
        ? need(name, REQUIRED)
        : value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '');
    },
    int: (name, fallback, min = 1) => {
      const value = text(env, name);
      if (value === undefined) return fallback ?? need(name, REQUIRED);
      const number = Number(value);
      return /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= min
        ? number
        : need(name, `must be an integer of at least ${min}`);
    },
  };
}

function budget(read: Reader, env: Env): WorkerBudget {
  const attempts = text(env, 'AW_WORKER_MAX_ATTEMPTS');
  return {
    leaseMs: read.int('AW_WORKER_LEASE_MS'),
    retry: {
      ...defaultRetryConfig,
      maxAttempts:
        attempts === undefined
          ? defaultRetryConfig.maxAttempts
          : read.int('AW_WORKER_MAX_ATTEMPTS'),
    },
  };
}

function admission(env: Env, read: Reader): AdmissionWiring | undefined {
  if (!on(env, 'AW_ADMISSION')) return undefined;
  return {
    leaseMs: read.int('AW_ADMISSION_LEASE_MS'),
    segmentId: read.string('AW_ADMISSION_SEGMENT'),
    estimatedCostMicros: read.int('AW_ADMISSION_ESTIMATE_MICROS', undefined, 0),
    sweepMs: read.int('AW_ADMISSION_SWEEP_MS', 30_000),
  };
}

function delivery(env: Env, read: Reader): DeliveryWiring | undefined {
  if (!on(env, 'AW_WORKER_DELIVERY')) return undefined;
  return {
    workerUrl: read.string('AW_WORKER_URL'),
    dispatcherEmails: read.list('AW_DISPATCHER_SA'),
    budget: budget(read, env),
  };
}

function outbox(env: Env, read: Reader): OutboxWiring | undefined {
  if (!on(env, 'AW_OUTBOX_PUBLISHER')) return undefined;
  return {
    queue: {
      projectId: read.string('AW_QUEUE_PROJECT'),
      location: read.string('AW_QUEUE_LOCATION'),
      queue: read.string('AW_QUEUE_NAME'),
      workerUrl: read.string('AW_WORKER_URL'),
      oidcServiceAccountEmail: read.string('AW_QUEUE_OIDC_SA'),
    },
    owner: text(env, 'AW_OUTBOX_OWNER') ?? `outbox-${process.pid}`,
    leaseMs: read.int('AW_OUTBOX_LEASE_MS'),
    intervalMs: read.int('AW_OUTBOX_INTERVAL_MS', 1000),
    batch: read.int('AW_OUTBOX_BATCH', 20),
    maxAttempts: read.int('AW_OUTBOX_MAX_ATTEMPTS', 8),
  };
}

function sweeper(env: Env, read: Reader): SweeperWiring | undefined {
  if (!on(env, 'AW_EXECUTION_SWEEPER')) return undefined;
  return {
    budget: budget(read, env),
    intervalMs: read.int('AW_SWEEP_INTERVAL_MS', 30_000),
    redriveAfterMs: read.int('AW_SWEEP_REDRIVE_AFTER_MS'),
    maxRedrives: read.int('AW_SWEEP_MAX_REDRIVES', undefined, 0),
    limit: read.int('AW_SWEEP_LIMIT', 100),
  };
}

function executionWorker(env: Env, read: Reader): ExecutionWorkerWiring | undefined {
  if (!on(env, 'AW_EXECUTION_WORKER')) return undefined;
  return {
    budget: budget(read, env),
    intervalMs: read.int('AW_EXECUTION_WORKER_INTERVAL_MS', 1000),
  };
}

function crossChecks(env: Env, wiring: Wiring, problems: string[]): void {
  const workerUrl = text(env, 'AW_WORKER_URL');
  if (
    (wiring.delivery !== undefined || wiring.outbox !== undefined) &&
    workerUrl !== undefined &&
    URL.parse(workerUrl)?.pathname !== '/internal/deliveries'
  )
    problems.push('AW_WORKER_URL must be the https URL of /internal/deliveries');
  if (
    text(env, 'AW_STANDING_GRANTS') === 'on' &&
    text(env, 'AW_STANDING_GRANTS_O04_REF') === undefined
  )
    problems.push('AW_STANDING_GRANTS_O04_REF is required when AW_STANDING_GRANTS is on');
}

/**
 * Reads the wiring flags. A capability whose flag is `on` but whose required values are missing or
 * malformed makes the whole read throw: the process must not start half-configured.
 */
export function readWiring(env: Env): Wiring {
  const problems: string[] = [];
  const read = reader(env, problems);
  const wiring: Wiring = {
    telemetry: on(env, 'AW_TELEMETRY'),
    opsDashboard: on(env, 'AW_OPS_DASHBOARD'),
    strictProposals: on(env, 'AW_STRICT_PROPOSALS'),
    admission: admission(env, read),
    delivery: delivery(env, read),
    outbox: outbox(env, read),
    sweeper: sweeper(env, read),
    executionWorker: executionWorker(env, read),
  };
  crossChecks(env, wiring, problems);
  if (problems.length > 0) throw new WiringConfigError([...new Set(problems)]);
  return wiring;
}

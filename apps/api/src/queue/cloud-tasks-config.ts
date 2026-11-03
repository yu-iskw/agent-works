/** Cloud Tasks HTTP targets accept a dispatch deadline of 15 s to 30 min. We stay below the cap. */
export const maxDispatchDeadlineSeconds = 29 * 60;
const minDispatchDeadlineSeconds = 15;

export type RetryConfig = {
  readonly maxAttempts: number;
  readonly minBackoffSeconds: number;
  readonly maxBackoffSeconds: number;
  readonly maxDoublings: number;
  readonly maxRetryDurationSeconds: number;
};

/** Queue-level backpressure. The concurrency cap bounds load on the database. */
export type RateLimits = {
  readonly maxDispatchesPerSecond: number;
  readonly maxConcurrentDispatches: number;
};

export type QueueConfig = {
  readonly projectId: string;
  readonly location: string;
  readonly queue: string;
  /** Exact worker endpoint URL; also the OIDC audience. */
  readonly workerUrl: string;
  /** Service account Cloud Tasks mints the OIDC token for. */
  readonly oidcServiceAccountEmail: string;
  readonly dispatchDeadlineSeconds: number;
  readonly retry: RetryConfig;
  readonly rateLimits: RateLimits;
};

export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 8,
  minBackoffSeconds: 5,
  maxBackoffSeconds: 600,
  maxDoublings: 6,
  maxRetryDurationSeconds: 6 * 60 * 60,
};

export const defaultRateLimits: RateLimits = {
  maxDispatchesPerSecond: 5,
  maxConcurrentDispatches: 10,
};

const saEmail = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const nameLike = /^[A-Za-z0-9-]{1,100}$/;

const bad = (message: string): never => {
  throw new Error(`invalid queue config: ${message}`);
};

function validateIdentity(config: QueueConfig): void {
  for (const [label, value] of [
    ['projectId', config.projectId],
    ['location', config.location],
    ['queue', config.queue],
  ] as const) {
    if (!nameLike.test(value)) bad(label);
  }
  if (!URL.canParse(config.workerUrl) || !config.workerUrl.startsWith('https://'))
    bad('workerUrl must be https');
  if (!saEmail.test(config.oidcServiceAccountEmail)) bad('oidcServiceAccountEmail');
}

function validateRetry(r: RetryConfig): void {
  if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1) bad('maxAttempts');
  if (r.minBackoffSeconds <= 0 || r.maxBackoffSeconds < r.minBackoffSeconds) bad('backoff bounds');
  if (!Number.isInteger(r.maxDoublings) || r.maxDoublings < 0) bad('maxDoublings');
  if (r.maxRetryDurationSeconds <= 0) bad('maxRetryDurationSeconds');
}

function validateRateLimits(l: RateLimits): void {
  if (l.maxDispatchesPerSecond <= 0) bad('maxDispatchesPerSecond');
  if (!Number.isInteger(l.maxConcurrentDispatches) || l.maxConcurrentDispatches < 1)
    bad('maxConcurrentDispatches');
}

export function validateQueueConfig(config: QueueConfig): QueueConfig {
  validateIdentity(config);
  const d = config.dispatchDeadlineSeconds;
  if (!Number.isInteger(d) || d < minDispatchDeadlineSeconds || d > maxDispatchDeadlineSeconds)
    bad('dispatchDeadlineSeconds must be below 30 minutes');
  validateRetry(config.retry);
  validateRateLimits(config.rateLimits);
  return config;
}

/**
 * Capped exponential backoff with jitter in the upper half: the delay for retry `attempt`
 * (1-based) is uniform in [cap/2, cap] where cap = min(max, min * 2^min(attempt-1, maxDoublings)).
 * `random` returns a value in [0, 1).
 */
export function backoffSeconds(
  retry: RetryConfig,
  attempt: number,
  random: () => number = Math.random,
): number {
  const doublings = Math.min(Math.max(attempt - 1, 0), retry.maxDoublings);
  const cap = Math.min(retry.maxBackoffSeconds, retry.minBackoffSeconds * 2 ** doublings);
  return cap / 2 + (cap / 2) * random();
}

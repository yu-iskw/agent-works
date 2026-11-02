export const POLL_MS = 2_500;
export const BACKOFF_MS = 8_000;
const BACKOFF_AFTER = 3;

/** Delay before the next poll, or null to wait for the document to become visible. */
export function nextDelay(failures: number, hidden: boolean): number | null {
  if (hidden) return null;
  return failures >= BACKOFF_AFTER ? BACKOFF_MS : POLL_MS;
}

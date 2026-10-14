/** Explicit operator configuration only. Empty, missing and malformed values disable delegation. */
export function delegationEnabled(value: string | undefined): boolean {
  return value === 'enabled';
}

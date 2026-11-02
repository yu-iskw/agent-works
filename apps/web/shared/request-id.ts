/**
 * A version 4 UUID for idempotent requests. `crypto.randomUUID` exists only in secure contexts,
 * and the workspace is also served over plain HTTP on a private network, so this builds the id
 * from `getRandomValues`, which every context has.
 */
export function requestId(random: (bytes: Uint8Array) => Uint8Array): string {
  const b = random(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

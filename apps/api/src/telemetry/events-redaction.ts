import { createHmac } from 'node:crypto';

/** No raw label is allowed out, even if it masquerades as an ID or model name. */
export type Redactor = { protect(value: string): string };
export function createRedactor(key: string): Redactor {
  if (key.length < 16) throw new RangeError('redaction key');
  return {
    protect(value) {
      return `p:${createHmac('sha256', key).update(value).digest('hex')}`;
    },
  };
}
export function opaqueId(value: string): string {
  if (!/^p:[a-f0-9]{64}$/.test(value)) throw new RangeError('protected identifier');
  return value;
}

import { canonicalPayloadJson } from './canonical-hash.js';
import { eventPayloadSchemaSchema } from './event-trigger.js';

import type { EventTrigger } from './event-trigger.js';

type Field = EventTrigger['payloadSchema']['properties'][string];
export function validEventPayload(
  schema: EventTrigger['payloadSchema'],
  payload: unknown,
): payload is Record<string, string | number | boolean> {
  eventPayloadSchemaSchema.parse(schema);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  try {
    if (Buffer.byteLength(canonicalPayloadJson(payload)) > 16384) return false;
  } catch {
    return false;
  }
  const values = new Map(Object.entries(payload));
  const fields = new Map(Object.entries(schema.properties));
  return (
    [...fields].every(([key, field]) =>
      values.has(key) ? validField(field, values.get(key)) : !field.required,
    ) && [...values.keys()].every((key) => fields.has(key))
  );
}
function validField(field: Field, value: unknown): boolean {
  if (typeof value !== field.type) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= (field.maxLength ?? 8192);
  return true;
}

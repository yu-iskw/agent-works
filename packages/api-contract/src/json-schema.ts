export type JsonSchema = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly propertyNames?: JsonSchema;
};
function objectValid(value: Record<string, unknown>, schema: JsonSchema): boolean {
  if (schema.required?.some((name) => !Object.hasOwn(value, name))) return false;
  if (
    schema.propertyNames !== undefined &&
    !Object.keys(value).every((name) => validJson(name, schema.propertyNames!))
  )
    return false;
  const properties = new Map(Object.entries(schema.properties ?? {}));
  return Object.entries(value).every(([name, bit]) => {
    const property = properties.get(name);
    if (property !== undefined) return validJson(bit, property);
    if (schema.additionalProperties === false) return false;
    if (typeof schema.additionalProperties === 'object')
      return validJson(bit, schema.additionalProperties);
    return true;
  });
}
function stringValid(value: string, schema: JsonSchema): boolean {
  if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))
    return false;
  // Patterns are generated from trusted domain schemas, never from request input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.format === 'date-time')
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (schema.format === 'uri') return URL.canParse(value);
  if (schema.format === 'uuid')
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  return true;
}
function numberValid(value: unknown, schema: JsonSchema): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false;
  return (
    value >= (schema.minimum ?? -Infinity) &&
    value <= (schema.maximum ?? Infinity) &&
    value > (schema.exclusiveMinimum ?? -Infinity) &&
    value < (schema.exclusiveMaximum ?? Infinity)
  );
}
function arrayValid(value: unknown, schema: JsonSchema): boolean {
  if (!Array.isArray(value)) return false;
  const elements: unknown[] = value;
  return (
    elements.length >= (schema.minItems ?? 0) &&
    elements.length <= (schema.maxItems ?? Infinity) &&
    elements.every((bit) => schema.items === undefined || validJson(bit, schema.items))
  );
}
function recordValid(value: unknown, schema: JsonSchema): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    objectValid(value as Record<string, unknown>, schema)
  );
}
function typedValid(value: unknown, schema: JsonSchema): boolean {
  const type = schema.type;
  if (type === undefined) return true;
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string' && stringValid(value, schema);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'number':
      return numberValid(value, schema);
    case 'array':
      return arrayValid(value, schema);
    case 'object':
      return recordValid(value, schema);
    default:
      return false;
  }
}
/** Validator for the closed JSON Schema vocabulary emitted by the domain schema compiler. */
export function validJson(value: unknown, schema: JsonSchema): boolean {
  if (schema.$ref !== undefined) {
    if (schema.$ref !== '#/components/schemas/JsonValue') return false;
    return jsonValue(value);
  }
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if (schema.oneOf !== undefined)
    return schema.oneOf.filter((arm) => validJson(value, arm)).length === 1;
  if (schema.anyOf !== undefined) return schema.anyOf.some((arm) => validJson(value, arm));
  if (typeof schema.type !== 'string' && schema.type !== undefined)
    return schema.type.some((type) => typedValid(value, { ...schema, type }));
  return typedValid(value, schema);
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (typeof value === 'object')
    return Object.values(value as Record<string, unknown>).every(jsonValue);
  return false;
}

import * as z from 'zod';
const schemaRef = z.strictObject({ $ref: z.string().startsWith('#/components/schemas/') });
const content = z.strictObject({ 'application/json': z.strictObject({ schema: schemaRef }) });
const parameter = z.strictObject({
  in: z.enum(['path', 'header']),
  name: z.string().min(1),
  required: z.boolean(),
  schema: z.strictObject({ type: z.literal('string'), minLength: z.number().int().nonnegative() }),
});
const operation = z.strictObject({
  operationId: z.string().min(1),
  summary: z.string(),
  parameters: z.array(parameter),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  'x-implemented': z.boolean(),
  responses: z.record(
    z.string().regex(/^[1-5]\d{2}$/),
    z.strictObject({ description: z.string().min(1), content: content.optional() }),
  ),
  requestBody: z.strictObject({ required: z.boolean(), content }).optional(),
});
const specSchema = z.strictObject({
  openapi: z.literal('3.1.0'),
  jsonSchemaDialect: z.literal('https://json-schema.org/draft/2020-12/schema'),
  info: z.strictObject({ title: z.string(), version: z.string(), description: z.string() }),
  servers: z.array(z.strictObject({ url: z.url() })),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  paths: z.record(
    z.string().startsWith('/'),
    z.partialRecord(z.enum(['get', 'post', 'delete']), operation),
  ),
  components: z.strictObject({
    securitySchemes: z.record(
      z.string(),
      z.strictObject({ type: z.literal('apiKey'), in: z.literal('header'), name: z.string() }),
    ),
    schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
  'x-route-fingerprints': z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, bit]) => [
        name,
        name === '$ref' ? bit.replace('#/components/schemas/', '#/$defs/') : rewriteRefs(bit),
      ]),
    );
  return value;
}
/** Validates our emitted OpenAPI 3.1 vocabulary and compiles every embedded JSON Schema. */
export function validateSpec(input) {
  const spec = specSchema.parse(input);
  const ids = new Set();
  const names = new Set(Object.keys(spec.components.schemas));
  for (const [path, item] of Object.entries(spec.paths))
    for (const op of Object.values(item)) {
      if (ids.has(op.operationId)) throw new Error('duplicate operation ID');
      ids.add(op.operationId);
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      if (
        placeholders.some(
          (name) => !op.parameters.some((p) => p.in === 'path' && p.name === name && p.required),
        )
      )
        throw new Error('missing path parameter');
      const refs = [
        op.requestBody?.content['application/json'].schema.$ref,
        ...Object.values(op.responses).map(
          (response) => response.content?.['application/json'].schema.$ref,
        ),
      ].filter(Boolean);
      if (refs.some((ref) => !names.has(ref.split('/').at(-1))))
        throw new Error('unresolved schema reference');
    }
  const defs = rewriteRefs(spec.components.schemas);
  for (const name of names) z.fromJSONSchema({ $defs: defs, $ref: `#/$defs/${name}` });
  return spec;
}

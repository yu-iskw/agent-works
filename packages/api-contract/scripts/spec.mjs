import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { schemaComponents } from './schema-source.mjs';
const packageRoot = new URL('../', import.meta.url);
const routeRoot = new URL('../../apps/api/src/routes/', packageRoot);
export function routeFingerprints(overrides = new Map()) {
  return Object.fromEntries(
    [
      ...readdirSync(routeRoot).filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
      ),
      ...['routes.ts', 'route-schema.ts', 'route-auth.ts'].map((name) => `../connectors/${name}`),
    ]
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(overrides.get(name) ?? readFileSync(new URL(name, routeRoot), 'utf8'))
          .digest('hex'),
      ]),
  );
}
export function buildSpec(overrides = new Map()) {
  const components = schemaComponents();
  const operations = JSON.parse(readFileSync(new URL('operations.json', packageRoot), 'utf8'));
  const paths = {};
  for (const op of operations) {
    const parameters = op.headers.map((name) => ({
      in: 'header',
      name,
      required: true,
      schema: { type: 'string', minLength: 1 },
    }));
    if (op.parameter)
      parameters.unshift({
        in: 'path',
        name: op.parameter,
        required: true,
        schema: { type: 'string', minLength: 1 },
      });
    const success = String(op.successStatus ?? 200);
    const entry = {
      operationId: op.operationId,
      summary: op.operationId,
      parameters,
      security: op.security ?? [{ iap: [] }],
      'x-implemented': op.implemented,
      responses: Object.fromEntries(
        [success, '400', '401', '403', '404', '409', '422', '501', '502', '503'].map((code) => [
          code,
          {
            description: code === success ? 'Successful response' : 'Safe API error',
            content: {
              'application/json': {
                schema: {
                  $ref: `#/components/schemas/${code === success && op.response ? op.response : 'Error'}`,
                },
              },
            },
          },
        ]),
      ),
    };
    if (!op.implemented)
      entry.responses['501'] = { description: 'Feature is not implemented; slot returns 501' };
    if (op.request)
      entry.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.request}` } } },
      };
    (paths[op.path] ??= {})[op.method.toLowerCase()] = entry;
  }
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Agent Works API',
      version: '1.0.0',
      description:
        'Offline route contracts. Feature slots may return 501. IAP authentication and policy remain authoritative.',
    },
    servers: [{ url: 'http://127.0.0.1:8084' }],
    security: [{ iap: [] }],
    paths,
    components: {
      securitySchemes: { iap: { type: 'apiKey', in: 'header', name: 'x-goog-iap-jwt-assertion' } },
      schemas: components,
    },
    'x-route-fingerprints': routeFingerprints(overrides),
  };
}
export function assertNoDrift(recorded, current) {
  if (JSON.stringify(recorded) !== JSON.stringify(current))
    throw new Error('OpenAPI drift: regenerate and review schema/route changes');
}

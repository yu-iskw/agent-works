import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSpec, assertNoDrift } from '../scripts/spec.mjs';
import { validateSpec } from '../scripts/validate.mjs';
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
describe('OpenAPI 3.1 schema contract', () => {
  it('validates every operation, path parameter and embedded JSON Schema', () => {
    expect(validateSpec(spec).openapi).toBe('3.1.0');
  });
  it('has no drift from current route sources and their actual schemas', () => {
    expect(() => assertNoDrift(spec, buildSpec())).not.toThrow();
  });
  it('fails drift when a route schema changes without regeneration', () => {
    const file = new URL('../../apps/api/src/routes/tasks.ts', new URL('../', import.meta.url));
    const changed = readFileSync(file, 'utf8').replace(
      'taskApiSchema.safeParse(body)',
      'taskSubmitSchema.safeParse(body)',
    );
    expect(() => assertNoDrift(spec, buildSpec(new Map([['tasks.ts', changed]])))).toThrow(
      'OpenAPI drift',
    );
  });
  it('fails drift when an existing domain request schema changes', () => {
    const changed = structuredClone(spec);
    changed.components.schemas.TaskSubmit.properties.objective.minLength = 100;
    expect(() => assertNoDrift(changed, buildSpec())).toThrow('OpenAPI drift');
  });
  it('rejects broken refs, undocumented parameters and duplicate IDs', () => {
    const broken = structuredClone(spec);
    broken.paths['/v1/tasks'].post.requestBody.content['application/json'].schema.$ref =
      '#/components/schemas/Missing';
    expect(() => validateSpec(broken)).toThrow('unresolved');
    const missing = structuredClone(spec);
    missing.paths['/v1/tasks/{taskId}'].get.parameters = [];
    expect(() => validateSpec(missing)).toThrow('missing path');
    const duplicate = structuredClone(spec);
    duplicate.paths['/v1/tasks'].post.operationId = 'readTask';
    expect(() => validateSpec(duplicate)).toThrow('duplicate');
  });
});

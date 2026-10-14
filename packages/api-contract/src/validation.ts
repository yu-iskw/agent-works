import { readFileSync } from 'node:fs';

import { validJson } from './json-schema.js';

const contractSpec = JSON.parse(
  // Static package contract path, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
) as {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, Record<string, Operation>>;
};
import type { JsonSchema } from './json-schema.js';
type Operation = {
  readonly operationId: string;
  readonly parameters: readonly {
    readonly in: string;
    readonly name: string;
    readonly required: boolean;
  }[];
  readonly requestBody?: {
    readonly content: {
      readonly 'application/json': { readonly schema: { readonly $ref: string } };
    };
  };
  readonly responses: Readonly<
    Record<
      string,
      {
        readonly content?: {
          readonly 'application/json': { readonly schema: { readonly $ref: string } };
        };
      }
    >
  >;
};
type ContractRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
};
type ContractReply = { readonly status: number; readonly body: unknown };
export type ContractRoute = (request: ContractRequest) => Promise<ContractReply>;
function resolveSchema(ref: string): JsonSchema {
  const name = ref.split('/').at(-1);
  const schemas = new Map<string, JsonSchema>(Object.entries(contractSpec.components.schemas));
  const schema = name === undefined ? undefined : schemas.get(name);
  if (schema === undefined) throw new Error('unknown contract schema');
  return schema;
}
function operationById(id: string): Operation {
  for (const item of Object.values(contractSpec.paths))
    for (const operation of Object.values(item)) if (operation.operationId === id) return operation;
  throw new Error('unknown operation');
}
export function validateOperationBody(id: string, value: unknown): boolean {
  const operation = operationById(id);
  const ref = operation.requestBody?.content['application/json'].schema.$ref;
  return ref === undefined ? value === undefined : validJson(value, resolveSchema(ref));
}
export function validateResponse(id: string, status: number, value: unknown): boolean {
  const operation = operationById(id);
  const response = new Map(Object.entries(operation.responses)).get(String(status));
  const ref = response?.content?.['application/json'].schema.$ref;
  return ref !== undefined && validJson(value, resolveSchema(ref));
}
export function validateOperationHeaders(id: string, headers: ContractRequest['headers']): boolean {
  const operation = operationById(id);
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return operation.parameters
    .filter((parameter) => parameter.in === 'header' && parameter.required)
    .every((parameter) => {
      const value = normalized.get(parameter.name.toLowerCase());
      return typeof value === 'string' && value.length > 0;
    });
}
/** Compose after authentication to preserve handler authorization order. Existing routes are untouched. */
export function withRequestValidation(operationId: string, next: ContractRoute): ContractRoute {
  operationById(operationId);
  return async (request) => {
    let body: unknown;
    try {
      body =
        request.body.length === 0
          ? undefined
          : (JSON.parse(request.body.toString('utf8')) as unknown);
    } catch {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    if (
      !validateOperationHeaders(operationId, request.headers) ||
      !validateOperationBody(operationId, body)
    )
      return { status: 400, body: { error: 'invalid_request' } };
    return next(request);
  };
}

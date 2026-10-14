function typeOf(schema) {
  if (!schema) return 'unknown';
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(typeOf).join(' | ');
  if (Array.isArray(schema.type))
    return schema.type.map((type) => typeOf({ ...schema, type })).join(' | ');
  if (schema.type === 'null') return 'null';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'array') return `readonly (${typeOf(schema.items)})[]`;
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? []);
    const props = Object.entries(schema.properties ?? {}).map(
      ([name, value]) =>
        `readonly ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${typeOf(value)};`,
    );
    if (schema.additionalProperties && schema.additionalProperties !== false)
      props.push(`readonly [key: string]: ${typeOf(schema.additionalProperties)};`);
    return `{ ${props.join(' ')} }`;
  }
  return 'unknown';
}
export function buildClient(spec) {
  const types = Object.entries(spec.components.schemas)
    .map(([name, schema]) => `export type ${name} = ${typeOf(schema)};`)
    .join('\n');
  const methods = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(item)) {
      if (!op['x-implemented']) continue;
      const parameter = op.parameters.find((p) => p.in === 'path');
      const request = op.requestBody?.content['application/json'].schema.$ref.split('/').at(-1);
      const response = Object.entries(op.responses)
        .find(([status]) => /^2\d{2}$/.test(status))[1]
        .content['application/json'].schema.$ref.split('/')
        .at(-1);
      const args = [
        ...(parameter ? [`${parameter.name}: string`] : []),
        ...(request ? [`body: ${request}`] : []),
        'headers: Readonly<Record<string, string>> = {}',
      ];
      const rendered = parameter
        ? path.replace(`{${parameter.name}}`, `\${encodeURIComponent(${parameter.name})}`)
        : path;
      methods.push(
        ` ${op.operationId}(${args.join(', ')}): Promise<${response}> { return this.transport.request<${response}>('${op.operationId}', '${method.toUpperCase()}', \`${rendered}\`, ${request ? 'body' : 'undefined'}, headers); }`,
      );
    }
  return `// Generated from openapi.json. Run pnpm api:generate; do not edit.
import { ContractTransport } from './transport.js';
import type { ClientOptions } from './transport.js';
${types}
export class ApiClient {
 private readonly transport: ContractTransport;
 constructor(options: ClientOptions) { this.transport = new ContractTransport(options); }
${methods.join('\n')}
}
`;
}

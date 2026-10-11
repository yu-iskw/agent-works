import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import * as z from 'zod';

import { approvalSchema } from './approval.js';
import { askResponseSchema } from './ask.js';
import { auditEventSchema } from './audit-event.js';
import { authoritySchema } from './authority.js';
import { outboxEventSchema, taskApiSchema } from './ledger.js';
import { policyDecisionSchema } from './policy.js';
import { principalSchema } from './principal.js';
import { searchContextSchema, sourceCitationSchema } from './search.js';
import { taskSchema } from './task.js';
import { toolCallSchema } from './tool-call.js';

const schemaDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/schemas',
);

const domainSchemas = [
  ['principal.json', principalSchema],
  ['authority.json', authoritySchema],
  ['task.json', taskSchema],
  ['approval.json', approvalSchema],
  ['tool-call.json', toolCallSchema],
  ['audit-event.json', auditEventSchema],
  ['policy-decision.json', policyDecisionSchema],
  ['search-context.json', searchContextSchema],
  ['citation.json', sourceCitationSchema],
  ['task-api.json', taskApiSchema],
  ['outbox-event.json', outboxEventSchema],
] as const;

export const domainSchemaNames = domainSchemas.map(([name]) => name);

type SchemaFile = {
  name: string;
  schema: z.ZodType;
  path: string;
  read: () => string | undefined;
  write: (next: string) => void;
};

async function renderSchema(schema: z.ZodType, path: string): Promise<string> {
  const config = await resolveConfig(path);
  return format(JSON.stringify(z.toJSONSchema(schema), null, 2), {
    ...config,
    filepath: path,
    parser: 'json',
  });
}

async function driftedName(check: boolean, file: SchemaFile): Promise<string | undefined> {
  const next = await renderSchema(file.schema, file.path);
  if (!check) {
    file.write(next);
    return undefined;
  }
  return file.read() === next ? undefined : file.name;
}

async function report(
  check: boolean,
  files: readonly SchemaFile[],
  success: string,
): Promise<string> {
  if (!check) {
    mkdirSync(schemaDirectory, { recursive: true });
  }
  const drifted = (await Promise.all(files.map((file) => driftedName(check, file)))).filter(
    (name) => name !== undefined,
  );
  if (drifted.length > 0) {
    throw new Error(`schemas drifted: ${drifted.join(', ')}`);
  }
  return success;
}

function schemaFile(name: string, schema: z.ZodType): SchemaFile {
  const path = resolve(schemaDirectory, name);
  /* eslint-disable security/detect-non-literal-fs-filename -- names are the schema registry, not external input */
  const file: SchemaFile = {
    name,
    schema,
    path,
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    write: (next) => {
      writeFileSync(path, next);
    },
  };
  /* eslint-enable security/detect-non-literal-fs-filename */
  return file;
}

export async function schemaReport(check: boolean): Promise<string> {
  return report(
    check,
    domainSchemas.map(([name, schema]) => schemaFile(name, schema)),
    `${domainSchemas.length} schemas up to date`,
  );
}

export async function contractReport(check: boolean): Promise<string> {
  return report(
    check,
    [schemaFile('ask-response.json', askResponseSchema)],
    '1 api contract up to date',
  );
}

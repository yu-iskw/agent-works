import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import * as z from 'zod';

import { approvalSchema } from './approval.js';
import { askResponseSchema } from './ask.js';
import { auditEventSchema } from './audit-event.js';
import { authoritySchema } from './authority.js';
import { principalSchema } from './principal.js';
import { taskSchema } from './task.js';
import { toolCallSchema } from './tool-call.js';

const schemaDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/schemas',
);
const principalPath = resolve(schemaDirectory, 'principal.json');
const authorityPath = resolve(schemaDirectory, 'authority.json');
const taskPath = resolve(schemaDirectory, 'task.json');
const approvalPath = resolve(schemaDirectory, 'approval.json');
const toolCallPath = resolve(schemaDirectory, 'tool-call.json');
const auditEventPath = resolve(schemaDirectory, 'audit-event.json');
const askResponsePath = resolve(schemaDirectory, 'ask-response.json');

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

export async function schemaReport(check: boolean): Promise<string> {
  return report(
    check,
    [
      {
        name: 'principal.json',
        schema: principalSchema,
        path: principalPath,
        read: () => (existsSync(principalPath) ? readFileSync(principalPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(principalPath, next);
        },
      },
      {
        name: 'authority.json',
        schema: authoritySchema,
        path: authorityPath,
        read: () => (existsSync(authorityPath) ? readFileSync(authorityPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(authorityPath, next);
        },
      },
      {
        name: 'task.json',
        schema: taskSchema,
        path: taskPath,
        read: () => (existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(taskPath, next);
        },
      },
      {
        name: 'approval.json',
        schema: approvalSchema,
        path: approvalPath,
        read: () => (existsSync(approvalPath) ? readFileSync(approvalPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(approvalPath, next);
        },
      },
      {
        name: 'tool-call.json',
        schema: toolCallSchema,
        path: toolCallPath,
        read: () => (existsSync(toolCallPath) ? readFileSync(toolCallPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(toolCallPath, next);
        },
      },
      {
        name: 'audit-event.json',
        schema: auditEventSchema,
        path: auditEventPath,
        read: () => (existsSync(auditEventPath) ? readFileSync(auditEventPath, 'utf8') : undefined),
        write: (next) => {
          writeFileSync(auditEventPath, next);
        },
      },
    ],
    '6 schemas up to date',
  );
}

export async function contractReport(check: boolean): Promise<string> {
  return report(
    check,
    [
      {
        name: 'ask-response.json',
        schema: askResponseSchema,
        path: askResponsePath,
        read: () =>
          existsSync(askResponsePath) ? readFileSync(askResponsePath, 'utf8') : undefined,
        write: (next) => {
          writeFileSync(askResponsePath, next);
        },
      },
    ],
    '1 api contract up to date',
  );
}

import { scheduleSpecSchema } from '../../../../packages/domain/dist/schedule.js';

import type { IncomingMessage } from 'node:http';
export async function readScheduleForm(
  request: IncomingMessage,
): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= 32768) chunks.push(buffer);
  }
  return size > 32768 ? undefined : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
export function parseScheduleForm(form: URLSearchParams) {
  let value: unknown;
  try {
    value = JSON.parse(form.get('spec') ?? '') as unknown;
  } catch {
    return undefined;
  }
  const parsed = scheduleSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function parseScheduleChange(
  form: URLSearchParams,
): { id: string; expectedRevision: number; action: 'pause' | 'resume' } | undefined {
  const id = form.get('id');
  const revision = Number(form.get('revision'));
  const action = form.get('action');
  if (
    id === null ||
    !/^[a-f0-9-]{36}$/.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (action !== 'pause' && action !== 'resume')
  )
    return undefined;
  return { id, expectedRevision: revision, action };
}

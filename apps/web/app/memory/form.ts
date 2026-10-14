import {
  memoryConsentCommandSchema,
  memoryDeleteSchema,
  memoryEditSchema,
} from '@agent-works/domain/user-memory';

import type { IncomingMessage } from 'node:http';
export async function readMemoryForm(
  request: IncomingMessage,
): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= 16384) chunks.push(buffer);
  }
  return size > 16384 ? undefined : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
export function memoryCommand(action: string, form: URLSearchParams): unknown {
  if (action === 'consent')
    return memoryConsentCommandSchema.parse({
      enabled: form.get('enabled') === 'true',
      revision: Number(form.get('revision')),
      noticeVersion: 'memory-v1',
    });
  const command = {
    id: form.get('id'),
    agent: form.get('agent'),
    revision: Number(form.get('revision')),
  };
  return action === 'edit'
    ? memoryEditSchema.parse({ ...command, text: form.get('text') })
    : memoryDeleteSchema.parse(command);
}

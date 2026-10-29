import type { IncomingMessage } from 'node:http';

/** Reads a request body up to `maxBytes`; undefined when it is larger. The rest is drained, not kept. */
export async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size <= maxBytes) chunks.push(bytes);
  }
  return size > maxBytes ? undefined : Buffer.concat(chunks);
}

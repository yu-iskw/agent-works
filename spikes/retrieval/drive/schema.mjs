// @ts-check
/** @typedef {z.infer<typeof driveRecordingSchema>} DriveRecording */
import { z } from 'zod';
const metadata = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  mimeType: z.enum(['text/plain', 'application/vnd.google-apps.document']),
  version: z.string().regex(/^\d+$/),
  trashed: z.boolean(),
  capabilities: z.object({ canDownload: z.boolean() }),
});
const exchangeSchema = z.strictObject({
  operation: z.enum(['list', 'metadata', 'content']),
  objectId: z.string().nullable(),
  status: z.number().int().min(100).max(599),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]),
});
export const driveRecordingSchema = z
  .strictObject({
    schemaId: z.literal('agent-works.retrieval.drive-recording'),
    schemaVersion: z.literal(1),
    provenance: z.literal('synthetic'),
    scenario: z.string().min(1),
    caller: z.enum(['alice', 'bob', 'reviewer', 'outsider']),
    expectedIds: z.array(z.string()),
    expectedError: z.enum(['credential', 'response', 'transport', 'limit']).nullable(),
    exchanges: z.array(exchangeSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    for (const exchange of value.exchanges) {
      if (exchange.status !== 200) continue;
      let success = true;
      if (exchange.operation === 'list') {
        success = z
          .object({ files: z.array(z.object({ id: z.string().min(1) })) })
          .safeParse(exchange.body).success;
      } else if (exchange.operation === 'metadata') {
        success = metadata.safeParse(exchange.body).success;
      } else success = typeof exchange.body === 'string';
      if (!success && value.expectedError !== 'response') {
        context.addIssue({ code: 'custom', message: 'recorded success response shape mismatch' });
      }
    }
  });
/** An ordered fake transport, not a live measurement. Reject unexpected requests. */
/**
 * @param {unknown} input
 */
export function replayTransport(input) {
  const recording = driveRecordingSchema.parse(input);
  const queue = [...recording.exchanges];
  /** @type {{ url: string; delegated: boolean }[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const load = (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    const next = queue.shift();
    if (!next || parsed.origin !== 'https://www.googleapis.com')
      return Promise.reject(new Error('unexpected replay request'));
    const path = parsed.pathname;
    const operation = requestOperation(parsed);
    const id = operation === 'list' ? null : path.split('/')[4];
    if (next.operation !== operation || next.objectId !== id)
      return Promise.reject(new Error('replay order mismatch'));
    const delegated =
      new Headers(init?.headers).get('authorization') === 'Bearer FAKE_REDACTED_DELEGATED';
    requests.push({ url: parsed.toString(), delegated });
    if (!delegated || init?.redirect !== 'error')
      return Promise.reject(new Error('missing delegated credential'));
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return Promise.resolve(new Response(body, { status: next.status }));
  };
  return { recording, load, requests, remaining: () => queue.length };
}
/**
 * @param {URL} url
 * @returns {'list' | 'content' | 'metadata'}
 */
function requestOperation(url) {
  if (url.pathname === '/drive/v3/files') return 'list';
  if (url.pathname.endsWith('/export') || url.searchParams.get('alt') === 'media') return 'content';
  return 'metadata';
}

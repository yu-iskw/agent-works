import { McpAdapterError } from '../mcp-adapter.js';

/** Bound the JSON-RPC envelope before the SDK buffers it; cap decoded tool text separately. */
export function boundedFetch(
  upstream: typeof fetch,
  maxOutputBytes: number,
  timeoutMs: number,
): typeof fetch {
  // JSON string escaping can expand each output byte sixfold. Discovery also needs room.
  const maxWireBytes = Math.max(64 * 1024, maxOutputBytes * 6 + 16 * 1024);
  return async (input, init) => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ]);
    const response = await upstream(input, { ...init, signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let received = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          received += value.byteLength;
          if (received > maxWireBytes) {
            void reader.cancel().catch(() => undefined);
            controller.error(new McpAdapterError('mcp_output_too_large'));
            return;
          }
          controller.enqueue(value);
        } catch {
          controller.error(new McpAdapterError('mcp_unavailable'));
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

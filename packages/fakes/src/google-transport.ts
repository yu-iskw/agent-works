import type { Handler } from './http.js';
/** Executes the same fake HTTP handler without opening sockets. Tests can use this
 * when a sandbox forbids listen(); production adapters still use fetch. */
export function googleFakeTransport(handler: Handler): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = Object.fromEntries(request.headers.entries());
    const reply = await handler({
      method: request.method,
      url: new URL(request.url),
      headers,
      body: Buffer.from(await request.arrayBuffer()),
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: Object.fromEntries(
        Object.entries(reply.headers ?? {}).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : value.join(', '),
        ]),
      ),
    });
  };
}

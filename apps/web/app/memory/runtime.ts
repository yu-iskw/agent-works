import { createWebApp } from '../web-app.js';

import { createMemoryHandler } from './handler.js';

import type { WebAppOptions } from '../web-app.js';
import type { RequestListener } from 'node:http';
/** Offline composition root, matching the API's governance runtime pattern.
 * Mount memory without changing any unrelated web routes. */
export function createMemoryWebApp(options: WebAppOptions): RequestListener {
  const fallback = createWebApp(options);
  const memory = createMemoryHandler(options);
  return (request, response) => {
    const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
    if (path === '/memory' || path?.startsWith('/memory/') === true) memory(request, response);
    else fallback(request, response);
  };
}

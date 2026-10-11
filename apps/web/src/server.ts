import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createApprovalsHandler } from '../app/approvals/handler.js';
import { createConnectionsApp } from '../app/connections/connections-app.js';
import { createWebApp } from '../app/web-app.js';

import type { WebAppOptions } from '../app/web-app.js';

export function createWebServer(options: WebAppOptions) {
  const approvals = createApprovalsHandler(options);
  const web = createConnectionsApp(options, createWebApp(options));
  return createServer((request, response) => {
    const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
    if (path !== undefined && /^\/approvals\/[^/]+(?:\/decide)?$/.test(path))
      approvals(request, response);
    else web(request, response);
  });
}

const entrypoint = process.argv.at(1);
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const apiUrl = process.env.API_URL;
  if (apiUrl === undefined || apiUrl.length === 0) {
    process.stderr.write('API_URL is required\n');
    process.exit(1);
  }
  createWebServer({ apiUrl }).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}

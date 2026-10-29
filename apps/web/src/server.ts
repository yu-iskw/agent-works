import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createApprovalsHandler } from '../app/approvals/handler.js';
import { createWorkspaceApprovalsHandler } from '../app/approvals/workspace-handler.js';
import { createConnectionsApp } from '../app/connections/connections-app.js';
import { createWebApp } from '../app/web-app.js';
import { createWorkbenchHandler, isWorkbenchPath } from '../app/workbench/handler.js';

import type { WebAppOptions } from '../app/web-app.js';

export function createWebServer(options: WebAppOptions & { readonly workbench?: boolean }) {
  const approvals = createApprovalsHandler(options);
  const web = createConnectionsApp(options, createWebApp(options));
  const workbench = options.workbench === true ? createWorkbenchHandler(options) : undefined;
  return createServer((request, response) => {
    const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
    if (workbench !== undefined && path !== undefined && isWorkbenchPath(path))
      workbench(request, response);
    else if (path?.startsWith('/approvals/workspace/') === true)
      createWorkspaceApprovalsHandler(options)(request, response);
    else if (path !== undefined && /^\/approvals\/[^/]+(?:\/decide)?$/.test(path))
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
  createWebServer({
    apiUrl,
    allowedApiHosts: process.env.AW_DEV_STACK === '1' ? ['api'] : [],
    workbench: process.env.WEB_WORKBENCH === '1',
  }).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}

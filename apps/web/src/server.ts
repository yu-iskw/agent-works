import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createWebApp } from '../app/web-app.js';

const apiUrl = process.env.API_URL;
if (apiUrl === undefined || apiUrl.length === 0) {
  process.stderr.write('API_URL is required\n');
  process.exit(1);
}

const clientDir = fileURLToPath(new URL('../client', import.meta.url));

createServer(createWebApp({ apiUrl, clientDir })).listen(
  Number(process.env.PORT ?? 8080),
  '0.0.0.0',
);

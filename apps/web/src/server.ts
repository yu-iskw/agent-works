import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.method === 'GET' && (request.url ?? '').split('?')[0] === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
    return;
  }
  response.writeHead(404).end();
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');

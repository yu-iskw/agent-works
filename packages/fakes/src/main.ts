import { createDirectory } from './fake-directory.js';
import { createDrive } from './fake-drive.js';
import { createLlm } from './fake-llm.js';
import { createGoogleWorkspace } from './google-workspace.js';
import { listen } from './http.js';
import { createIapProxy } from './iap-proxy.js';

const port = Number(process.env.PORT ?? 8080);
const role = process.argv[2];
const upstream = process.env.UPSTREAM_URL;

if (role === 'iap') {
  if (upstream === undefined || upstream.length === 0) {
    process.stderr.write('UPSTREAM_URL is required\n');
    process.exit(1);
  }
  await listen(createIapProxy(upstream, { signIn: process.env.FAKE_IAP_SIGN_IN === '1' }), port);
} else if (role === 'drive')
  await listen(createDrive(process.env.DIRECTORY_URL, process.env.DRIVE_WORKER_TOKEN), port);
else if (role === 'llm') await listen(createLlm(), port);
else if (role === 'workspace') await listen(createGoogleWorkspace(), port);
else if (role === 'directory') await listen(createDirectory(), port);
else {
  process.stderr.write('usage: main.js iap|drive|llm|directory|workspace\n');
  process.exit(1);
}

import { createListener } from './http.js';
import { createAskRoute } from './routes/ask.js';

import type { AskDeps } from './routes/ask.js';
import type { RequestListener } from 'node:http';

export function createApp(deps: AskDeps): RequestListener {
  return createListener({
    'POST /v1/ask': createAskRoute(deps),
  });
}

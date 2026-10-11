import type { ApiReply, Route } from '../http.js';

export const notImplementedReply = {
  status: 501,
  body: { error: 'not_implemented' },
} as const satisfies ApiReply;

export const notImplementedRoute: Route = () => Promise.resolve(notImplementedReply);

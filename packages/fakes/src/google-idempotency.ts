import { canonicalPayloadSha256 } from '@agent-works/domain';

import { googleInvalid } from './google-auth.js';
import { header } from './http.js';

import type { GoogleFakeOptions } from './google-auth.js';
import type { Request, Reply } from './http.js';
export function googleIdempotency() {
  const receipts = new Map<string, { digest: string; reply: Reply }>();
  return {
    create(
      request: Request,
      options: GoogleFakeOptions,
      subject: string,
      payload: unknown,
      operation: () => Reply,
    ): Reply {
      const key = header(request.headers, 'idempotency-key');
      if (!key || key.length > 512) return googleInvalid;
      const scoped = JSON.stringify([subject, request.url.pathname, key]);
      const digest = canonicalPayloadSha256(payload);
      const existing = receipts.get(scoped);
      if (existing)
        return existing.digest === digest
          ? existing.reply
          : { status: 409, body: { error: 'idempotency_conflict' } };
      const reply = operation();
      if (reply.status >= 200 && reply.status < 300) receipts.set(scoped, { digest, reply });
      if (reply.status < 300 && options.lostResponses && options.lostResponses.remaining > 0) {
        options.lostResponses.remaining -= 1;
        return { status: 503, body: { error: 'lost_response' } };
      }
      return reply;
    },
  };
}

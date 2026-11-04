import { createServiceIdentityPolicy } from '../auth/service-identity.js';
import { headerValue } from '../http.js';
import { createRs256JwksVerifier } from '../queue/rs256-jwks-verifier.js';
import { createDeliveryHandler } from '../queue/worker-delivery.js';
import { createPostgresDeliveryStore } from '../worker/delivery-store.js';
import { workerReady } from '../worker/migration.js';

import type { DeliveryWiring } from './flags.js';
import type { Route } from '../http.js';
import type { VerifyIdToken } from '../queue/rs256-jwks-verifier.js';
import type { DeliveryStore } from '../queue/worker-delivery.js';
import type postgres from 'postgres';

export const DELIVERY_PATH = '/internal/deliveries';

type DeliveryParts = {
  readonly verifyIdToken?: VerifyIdToken;
  readonly store?: DeliveryStore;
  readonly now?: () => Date;
};

/**
 * `POST /internal/deliveries`. It is not an IAP route: the caller is Cloud Tasks presenting an OIDC
 * token minted for the dispatcher service account, which the handler verifies (signature, issuer,
 * audience = worker URL, allowlisted email) before it reads the body or touches the database.
 */
export async function createDeliveryRoutes(
  sql: postgres.Sql,
  wiring: DeliveryWiring,
  parts: DeliveryParts = {},
): Promise<Readonly<Record<string, Route>>> {
  if (parts.store === undefined) await workerReady(sql);
  const now = parts.now ?? (() => new Date());
  const handle = createDeliveryHandler({
    verifyIdToken: parts.verifyIdToken ?? createRs256JwksVerifier(),
    policy: createServiceIdentityPolicy({
      audience: wiring.workerUrl,
      authorizedEmails: wiring.dispatcherEmails,
    }),
    store: parts.store ?? createPostgresDeliveryStore(sql, { budget: wiring.budget, now }),
    now: () => now().getTime(),
  });
  return {
    [`POST ${DELIVERY_PATH}`]: async (request) => {
      const reply = await handle({
        authorization: headerValue(request.headers, 'authorization'),
        body: request.body,
      });
      return { status: reply.status, body: { outcome: reply.outcome } };
    },
  };
}

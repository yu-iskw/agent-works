export type TransportDocument = {
  id: string;
  folder: string;
  title: string;
  text: string;
  webViewLink: string;
};

type TransportOptions = {
  documents: readonly TransportDocument[];
  subject: string;
  groups: readonly string[];
  directoryUnavailable?: boolean;
  modelUnavailable?: boolean;
  modelCall?: { name: string; args: Record<string, unknown> };
  modelAnswer?: string;
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

function modelReply(options: TransportOptions): unknown {
  const part =
    options.modelCall === undefined
      ? { text: options.modelAnswer ?? 'No grounded answer.' }
      : { functionCall: options.modelCall };
  return { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] };
}

export type AdversarialTransport = {
  fetch: typeof fetch;
  revokeGroups(): void;
  requests(): readonly { path: string; method: string }[];
};

/** Deliberately overbroad Drive transport. The real retrieval adapter must filter it. */
export function createAdversarialTransport(options: TransportOptions): AdversarialTransport {
  let groups = [...options.groups];
  const requests: { path: string; method: string }[] = [];
  return {
    revokeGroups() {
      groups = [];
    },
    requests: () => structuredClone(requests),
    fetch(input, init) {
      const url = requestUrl(input);
      requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
      let body: unknown;
      let status = 200;
      if (url.hostname === 'drive.fake.test' && url.pathname === '/documents')
        body = options.documents;
      else if (
        url.hostname === 'directory.fake.test' &&
        url.pathname === `/snapshots/${options.subject}`
      ) {
        status = options.directoryUnavailable === true ? 503 : 200;
        body = { sub: options.subject, groups, observedAt: '2026-10-14T00:00:00.000Z' };
      } else if (url.hostname === 'llm.fake.test' && url.pathname.endsWith(':generateContent')) {
        status = options.modelUnavailable === true ? 503 : 200;
        body = modelReply(options);
      } else {
        status = 404;
        body = { error: 'unregistered offline destination' };
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

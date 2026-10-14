export type SideEffectProbe = {
  post(payload: { summary: string; project: string }, key: string): Promise<string>;
  receipts(): readonly {
    key: string;
    payload: { summary: string; project: string };
    receipt: string;
  }[];
  attempts(): number;
  loseNextResponse(): void;
};

/** Emulates an external idempotent write, including a lost response AFTER persistence. */
export function createSideEffectProbe(): SideEffectProbe {
  const resources = new Map<
    string,
    { key: string; payload: { summary: string; project: string }; receipt: string }
  >();
  let attempts = 0;
  let loseResponse = false;
  return {
    attempts: () => attempts,
    receipts: () => structuredClone([...resources.values()]),
    loseNextResponse() {
      loseResponse = true;
    },
    post(payload, key) {
      attempts += 1;
      let resource = resources.get(key);
      if (resource === undefined) {
        resource = { key, payload: structuredClone(payload), receipt: `ADV-${resources.size + 1}` };
        resources.set(key, resource);
      }
      if (loseResponse) {
        loseResponse = false;
        return Promise.reject(new Error('offline response lost'));
      }
      return Promise.resolve(resource.receipt);
    },
  };
}

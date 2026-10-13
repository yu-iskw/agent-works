import type { SearchContext, SkillManifest } from '@agent-works/domain';

export type SkillPackage = {
  readonly manifest: SkillManifest;
  readonly prompt: string;
};

export type IncidentExecution = {
  readonly deadline: number;
  readonly signal?: AbortSignal;
};

export type IncidentModel = {
  answer(this: void, question: string, execution: IncidentExecution): Promise<string>;
};

export type DeliverInput = {
  readonly callerContext?: SearchContext;
  readonly skill: SkillPackage;
  readonly deliveryId: string;
  readonly incidentId: string;
  readonly incidentsUrl: string;
  readonly ticketsUrl: string;
  readonly model: IncidentModel;
  readonly timeoutMs: number;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly ledger: Map<string, string>;
  readonly issuedWrites?: Set<string>;
};

export type Delivery =
  | { readonly kind: 'written'; readonly ticketId: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' };

type Incident = {
  readonly id: string;
  readonly title: string;
  readonly note: string;
};

export async function deliverIncident(input: DeliverInput): Promise<Delivery> {
  const known = input.ledger.get(input.deliveryId);
  if (known !== undefined) return { kind: 'written', ticketId: known };
  if (input.skill.manifest.state === 'REVOKED') return { kind: 'revoked' };
  const execution = createExecution(input);
  try {
    const incident = await execution.run(() =>
      readIncident(input.incidentsUrl, input.incidentId, execution.signal),
    );
    const answer = await execution.run(() =>
      input.model.answer(questionFor(input.skill, incident), execution),
    );
    const ticketId = await execution.run(async () => {
      input.issuedWrites?.add(input.deliveryId);
      const receipt = await postTicket(
        input.ticketsUrl,
        input.deliveryId,
        answer.trim(),
        execution.signal,
      );
      input.ledger.set(input.deliveryId, receipt);
      return receipt;
    });
    return { kind: 'written', ticketId };
  } catch {
    const receipt = input.ledger.get(input.deliveryId);
    if (receipt !== undefined) return { kind: 'written', ticketId: receipt };
    return { kind: execution.failure() };
  } finally {
    execution.dispose();
  }
}

export async function reconcileIncident(
  input: Pick<DeliverInput, 'ticketsUrl' | 'deliveryId' | 'ledger'>,
): Promise<Delivery> {
  const execution = createExecution({ timeoutMs: 1000 });
  try {
    return await execution.run(async () => {
      const response = await fetch(new URL('/tickets', input.ticketsUrl), {
        signal: execution.signal,
      });
      if (!response.ok) throw new Error('ticket');
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.tickets)) throw new Error('ticket');
      const receipt: unknown = body.tickets.find(
        (ticket: unknown) => isRecord(ticket) && ticket.idempotencyKey === input.deliveryId,
      );
      execution.signal.throwIfAborted();
      if (!isRecord(receipt) || typeof receipt.id !== 'string' || receipt.id.length === 0) {
        return { kind: 'timeout' };
      }
      input.ledger.set(input.deliveryId, receipt.id);
      return { kind: 'written', ticketId: receipt.id };
    });
  } catch {
    return { kind: execution.failure() };
  } finally {
    execution.dispose();
  }
}

function createExecution(input: Pick<DeliverInput, 'deadline' | 'timeoutMs' | 'signal'>) {
  const deadline = input.deadline ?? Date.now() + input.timeoutMs;
  const controller = new AbortController();
  const expire = () => controller.abort(new Error('incident deadline'));
  const cancel = () => controller.abort(new Error('incident cancelled'));
  const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  input.signal?.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) expire();
    if (input.signal?.aborted) cancel();
    controller.signal.throwIfAborted();
  };
  return {
    deadline,
    signal: controller.signal,
    failure(): 'timeout' | 'cancelled' | 'failed' {
      if (!Number.isFinite(deadline) || Date.now() >= deadline) return 'timeout';
      return input.signal?.aborted ? 'cancelled' : 'failed';
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      check();
      let abort = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('incident stopped'));
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await Promise.race([operation(), stopped]);
      } finally {
        controller.signal.removeEventListener('abort', abort);
      }
    },
    dispose() {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', cancel);
    },
  };
}

function questionFor(skill: SkillPackage, incident: Incident): string {
  return `${skill.prompt}\n\nIncident ${incident.id}: ${incident.title}\n${incident.note}`;
}

async function readIncident(
  incidentsUrl: string,
  incidentId: string,
  signal: AbortSignal,
): Promise<Incident> {
  const response = await fetch(new URL(`/incidents/${incidentId}`, incidentsUrl), { signal });
  if (!response.ok) throw new Error('incident');
  const body: unknown = await response.json();
  if (!isIncident(body)) throw new Error('incident');
  return body;
}

async function postTicket(
  ticketsUrl: string,
  deliveryId: string,
  summary: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL('/tickets', ticketsUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': deliveryId,
    },
    body: JSON.stringify({ summary, project: 'incidents' }),
    signal,
  });
  if (!response.ok) throw new Error('ticket');
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error('ticket');
  }
  return body.id;
}

export function isIncident(value: unknown): value is Incident {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.note === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

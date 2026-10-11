import type { SearchContext, SkillManifest } from '@agent-works/domain';

export type SkillPackage = {
  readonly manifest: SkillManifest;
  readonly prompt: string;
};

export type IncidentModel = {
  answer(question: string): Promise<string>;
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
  readonly ledger: Map<string, string>;
};

export type Delivery =
  | { readonly kind: 'written'; readonly ticketId: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'revoked' };

type Incident = {
  readonly id: string;
  readonly title: string;
  readonly note: string;
};

export async function deliverIncident(input: DeliverInput): Promise<Delivery> {
  if (input.skill.manifest.state === 'REVOKED') return { kind: 'revoked' };
  const known = input.ledger.get(input.deliveryId);
  if (known !== undefined) return { kind: 'written', ticketId: known };
  const incident = await readIncident(input.incidentsUrl, input.incidentId);
  const answer = await input.model.answer(questionFor(input.skill, incident));
  try {
    const ticketId = await postTicket(
      input.ticketsUrl,
      input.deliveryId,
      answer.trim(),
      input.timeoutMs,
    );
    input.ledger.set(input.deliveryId, ticketId);
    return { kind: 'written', ticketId };
  } catch (error) {
    if (isTimeout(error)) return { kind: 'timeout' };
    throw error;
  }
}

function questionFor(skill: SkillPackage, incident: Incident): string {
  return `${skill.prompt}\n\nIncident ${incident.id}: ${incident.title}\n${incident.note}`;
}

async function readIncident(incidentsUrl: string, incidentId: string): Promise<Incident> {
  const response = await fetch(new URL(`/incidents/${incidentId}`, incidentsUrl));
  if (!response.ok) throw new Error('incident');
  const body: unknown = await response.json();
  if (!isIncident(body)) throw new Error('incident');
  return body;
}

async function postTicket(
  ticketsUrl: string,
  deliveryId: string,
  summary: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(new URL('/tickets', ticketsUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': deliveryId,
    },
    body: JSON.stringify({ summary, project: 'incidents' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('ticket');
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error('ticket');
  }
  return body.id;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isIncident(value: unknown): value is Incident {
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

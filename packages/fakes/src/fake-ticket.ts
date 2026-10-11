import { header } from './http.js';

import type { Handler, Reply, Request } from './http.js';

type Ticket = {
  id: string;
  summary: string;
  project: string;
  idempotencyKey: string;
};

export function createTicket(): Handler {
  const tickets = new Map<string, Ticket>();
  return (request) => {
    if (request.method === 'POST' && request.url.pathname === '/tickets') {
      return create(tickets, request);
    }
    if (request.method === 'GET' && request.url.pathname === '/tickets') {
      return { status: 200, body: { tickets: [...tickets.values()] } };
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

function create(tickets: Map<string, Ticket>, request: Request): Reply {
  const idempotencyKey = header(request.headers, 'idempotency-key');
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    return { status: 400, body: { error: 'idempotency_key' } };
  }
  const existing = tickets.get(idempotencyKey);
  if (existing !== undefined) return { status: 200, body: receipt(existing) };
  const fields = readTicket(request.body);
  if (fields === undefined) return { status: 400, body: { error: 'bad body' } };
  const ticket: Ticket = {
    id: `FAKE-${tickets.size + 1}`,
    summary: fields.summary,
    project: fields.project,
    idempotencyKey,
  };
  tickets.set(idempotencyKey, ticket);
  return { status: 200, body: receipt(ticket) };
}

function receipt(ticket: Ticket): { id: string; receipt: string } {
  return { id: ticket.id, receipt: ticket.id };
}

function readTicket(body: Buffer): { summary: string; project: string } | undefined {
  const parsed = readJson(body);
  if (parsed === undefined) return undefined;
  if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) return undefined;
  if (typeof parsed.project !== 'string' || parsed.project.length === 0) return undefined;
  return { summary: parsed.summary, project: parsed.project };
}

function readJson(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

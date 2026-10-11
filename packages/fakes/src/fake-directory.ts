import { fakeUsers } from './iap-proxy.js';

import type { Handler, Reply } from './http.js';

export const agentUsersGroup = 'agent-users@company.example';

type Snapshot = {
  sub: string;
  groups: string[];
  observedAt: string;
};

export function seededGroups(sub: string): readonly string[] {
  return fakeUsers.some((user) => user === sub) ? [agentUsersGroup] : [];
}

export function snapshotGroups(body: unknown): readonly string[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.groups)) return undefined;
  const groups: string[] = [];
  for (const group of body.groups) {
    if (typeof group !== 'string') return undefined;
    groups.push(group);
  }
  return groups;
}

export function createDirectory(): Handler {
  const state = new Map<string, Snapshot>();
  for (const sub of fakeUsers) {
    state.set(sub, { sub, groups: [...seededGroups(sub)], observedAt: new Date().toISOString() });
  }
  return (request) => {
    const match = /^\/snapshots\/([a-z]+)$/.exec(request.url.pathname);
    if (request.method === 'GET' && match !== null) {
      const snapshot = state.get(match[1]);
      return snapshot === undefined
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: { ...snapshot, observedAt: new Date().toISOString() } };
    }
    if (request.method === 'POST' && request.url.pathname === '/revocations') {
      return revoke(state, request.body);
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

function revoke(state: Map<string, Snapshot>, body: Buffer): Reply {
  const parsed = readRevocation(body);
  if (parsed === undefined) return { status: 400, body: { error: 'bad body' } };
  const current = state.get(parsed.sub);
  if (current === undefined) return { status: 404, body: { error: 'not found' } };
  const next: Snapshot = {
    sub: current.sub,
    groups: current.groups.filter((group) => group !== parsed.group),
    observedAt: new Date().toISOString(),
  };
  state.set(current.sub, next);
  return { status: 200, body: next };
}

function readRevocation(body: Buffer): { sub: string; group: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed) || typeof parsed.sub !== 'string' || typeof parsed.group !== 'string') {
      return undefined;
    }
    if (parsed.sub.length === 0 || parsed.group.length === 0) return undefined;
    return { sub: parsed.sub, group: parsed.group };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { capabilityVersionCommandSchema, suspensionCommandSchema } from '@agent-works/domain';

import { headerValue } from '../http.js';
import { SuspensionConflict } from '../ports/suspension-ledger.js';

import { requireAdmin } from './admin-auth.js';

import type { AdminDeps } from './admin-auth.js';
import type { Route } from '../http.js';
import type { AdminCommand } from '../ports/suspension-ledger.js';

export function adminChangeRoutes(deps: AdminDeps): Readonly<Record<string, Route>> {
  return {
    'POST /v1/admin/suspensions': change(deps, 'suspension'),
    'POST /v1/admin/versions': change(deps, 'version'),
  };
}
function change(deps: AdminDeps, kind: AdminCommand['kind']): Route {
  return requireAdmin(deps, async (subject, request) => {
    const contentType = headerValue(request.headers, 'content-type');
    if (contentType?.split(';')[0] !== 'application/json')
      return { status: 415, body: { error: 'json_required' } };
    const payload = readJson(request.body);
    const input = parseCommand(payload, kind);
    if (input === undefined) return { status: 400, body: { error: 'invalid_admin_command' } };
    try {
      const result = await deps.ledger.change(input, subject, deps.now());
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof SuspensionConflict)
        return { status: 409, body: { error: 'admin_conflict', message: error.message } };
      throw error;
    }
  });
}
function readJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
function parseCommand(value: unknown, kind: AdminCommand['kind']): AdminCommand | undefined {
  if (kind === 'suspension') {
    const parsed = suspensionCommandSchema.safeParse(value);
    return parsed.success ? { kind, command: parsed.data } : undefined;
  }
  const parsed = capabilityVersionCommandSchema.safeParse(value);
  return parsed.success ? { kind, command: parsed.data } : undefined;
}

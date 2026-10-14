import { taskSchema } from '@agent-works/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryApprovalStore } from '../broker/approvals.js';
import { createMemoryCredentialsPort } from '../ports/memory/credentials.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createSkillRegistry } from '../skills/registry.js';

import { createDevWorkspaceRuntime } from './dev-runtime.js';
import { createWorkspaceRuntime } from './runtime.js';

import type { WorkspaceRuntimeDeps } from './runtime.js';
import type { AppRole } from '../auth/directory.js';
import type { Caller } from '../auth/iap.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type * as approvalsModule from '../broker/approvals.js';
import type { OAuthFlow } from '../credentials/flow.js';
import type { CredentialsPort } from '../ports/credentials.js';

const stores = vi.hoisted(() => ({
  approvals: vi.fn<() => ApprovalStore>(),
  credentials: vi.fn<() => { credentials: CredentialsPort }>(),
}));
vi.mock('../broker/approvals.js', async (original) => ({
  ...(await original<typeof approvalsModule>()),
  createPostgresApprovalStore: () => stores.approvals(),
}));
vi.mock('../credentials/postgres.js', () => ({
  createPostgresCredentialStore: () => stores.credentials(),
}));
vi.mock('./runtime.js', () => ({ createWorkspaceRuntime: vi.fn(() => ({})) }));

beforeEach(() => vi.clearAllMocks());
function harness() {
  const approvals = createMemoryApprovalStore();
  stores.approvals.mockReturnValue(approvals);
  stores.credentials.mockReturnValue({ credentials: createMemoryCredentialsPort() });
  const ledger = createMemoryLedgerPort();
  const task = taskSchema.parse({
    id: 'task-1',
    createdBySub: 'alice',
    status: 'RUNNING',
    objectiveDigest: 'a'.repeat(64),
    skillVersion: 'meeting-prep',
    agentVersion: '1',
    policyVersion: '1',
    budget: 1,
    version: 1,
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
  });
  const read = vi
    .spyOn(ledger, 'read')
    .mockImplementation((subject) => Promise.resolve(subject === 'alice' ? task : undefined));
  const held = new Map<string, readonly AppRole[]>([
    ['alice', ['Employee']],
    ['reviewer', ['Reviewer']],
  ]);
  const rolesFor = vi.fn((subject: string) => Promise.resolve(held.get(subject) ?? []));
  const check = vi.fn(() => Promise.resolve());
  createDevWorkspaceRuntime({
    sql: {} as Parameters<typeof createDevWorkspaceRuntime>[0]['sql'],
    baseUrl: 'http://127.0.0.1:8087',
    redirectUri: 'http://localhost/oauth/callback',
    flow: {} as OAuthFlow,
    verify: (assertion) => Promise.resolve({ sub: assertion, assertion } as Caller),
    rolesFor,
    groups: () => Promise.resolve({ groups: ['agent-users@company.example'] }),
    ledger,
    skills: () => createSkillRegistry(),
    enforcement: { check },
    drive: { retrieve: () => Promise.resolve([]), open: () => Promise.reject(new Error('unused')) },
    runner: { run: () => Promise.reject(new Error('unused')) },
    now: () => new Date('2026-10-15T00:00:00Z'),
  });
  const deps: WorkspaceRuntimeDeps = vi.mocked(createWorkspaceRuntime).mock.calls[0][0];
  return { deps, read, held, task, check };
}

describe('dev connector authorization wiring', () => {
  it('allows only owned tasks with declared tools and current membership', async () => {
    const h = harness();
    expect(await h.deps.routes.authorizePreparation('alice', 'task-1', 'docs.createDraft')).toBe(
      true,
    );
    expect(h.check).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'alice',
        teams: ['agent-users@company.example'],
        tool: { kind: 'tool', id: 'docs.createDraft', version: '1.0.0' },
      }),
      'tool',
    );
    expect(await h.deps.routes.authorizePreparation('bob', 'task-1', 'docs.createDraft')).toBe(
      false,
    );
    expect(await h.deps.routes.authorizePreparation('alice', 'task-1', 'gmail.createDraft')).toBe(
      false,
    );
    h.held.set('alice', []);
    expect(await h.deps.routes.authorizePreparation('alice', 'task-1', 'docs.createDraft')).toBe(
      false,
    );
  });
  it('denies cancelled tasks and propagates suspension failures', async () => {
    const h = harness();
    h.read.mockResolvedValueOnce({ ...h.task, status: 'CANCELLED' });
    expect(await h.deps.routes.authorizePreparation('alice', 'task-1', 'docs.createDraft')).toBe(
      false,
    );
    h.check.mockRejectedValueOnce(new Error('suspended'));
    await expect(
      h.deps.routes.authorizePreparation('alice', 'task-1', 'docs.createDraft'),
    ).rejects.toThrow('suspended');
  });
  it('refreshes approver membership on each authenticated request', async () => {
    const h = harness();
    await h.deps.routes.verify('reviewer');
    expect(h.deps.broker.approverAuthorized('reviewer')).toBe(true);
    h.held.set('reviewer', []);
    await h.deps.routes.verify('reviewer');
    expect(h.deps.broker.approverAuthorized('reviewer')).toBe(false);
  });
});

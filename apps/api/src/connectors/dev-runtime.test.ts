import { taskSchema } from '@agent-works/domain';
import { workspaceManifests } from '@agent-works/domain/workspace-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryApprovalStore } from '../broker/approvals.js';
import { createMemoryCredentialsPort } from '../ports/memory/credentials.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createIncidentSkill } from '../skills/incident.js';
import { createSkillRegistry } from '../skills/registry.js';
import { publishBundledCapabilities } from '../suspension/bootstrap.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';
import { bundledVersionBaseline } from '../suspension/runtime.js';
import { testAt, versionCommand } from '../suspension/test-fixtures.js';
import { authorizedCaller } from '../testing/task-authorization.js';

import { createDevWorkspaceRuntime } from './dev-runtime.js';
import { createWorkspaceRuntime } from './runtime.js';

import type { WorkspaceRuntimeDeps } from './runtime.js';
import type { AppRole } from '../auth/directory.js';
import type { Caller } from '../auth/iap.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type * as approvalsModule from '../broker/approvals.js';
import type { OAuthFlow } from '../credentials/flow.js';
import type { CredentialsPort } from '../ports/credentials.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';

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
  const check = vi.fn<SuspensionEnforcer['check']>(() => Promise.resolve());
  const openWorker = vi.fn(() =>
    Promise.resolve({
      context: authorizedCaller.context,
      port: { search: () => Promise.resolve([]) },
    }),
  );
  const context = {
    ...authorizedCaller.context,
    allowedSources: ['docs', 'calendar', 'gmail', 'drive'],
  };
  const sql = vi.fn(() => Promise.resolve([{ context }]));
  createDevWorkspaceRuntime({
    sql: sql as unknown as Parameters<typeof createDevWorkspaceRuntime>[0]['sql'],
    baseUrl: 'http://127.0.0.1:8087',
    redirectUri: 'http://localhost/oauth/callback',
    flow: {} as OAuthFlow,
    verify: (assertion) => Promise.resolve({ sub: assertion, assertion } as Caller),
    rolesFor,
    groups: () => Promise.resolve({ groups: ['agent-users@company.example'] }),
    ledger,
    skills: () => createSkillRegistry(),
    enforcement: { check },
    drive: {
      openWorker,
      retrieve: () => Promise.resolve([]),
      open: () => Promise.reject(new Error('unused')),
    },
    runner: { run: () => Promise.reject(new Error('unused')) },
    now: () => new Date('2026-10-15T00:00:00Z'),
  });
  const deps: WorkspaceRuntimeDeps = vi.mocked(createWorkspaceRuntime).mock.calls[0][0];
  return { deps, read, held, task, check, openWorker, context, sql };
}

async function publishedEnforcement() {
  const ledger = createMemorySuspensionLedger();
  await publishBundledCapabilities(ledger, bundledVersionBaseline(createIncidentSkill().manifest));
  await publishBundledCapabilities(ledger, [
    ...createSkillRegistry()
      .list()
      .filter((manifest) => ['meeting-prep', 'workspace-task'].includes(manifest.id))
      .map((manifest) => ({
        pin: { kind: 'skill' as const, id: manifest.id, version: manifest.version },
        reason: 'Bundled workspace skill',
      })),
    ...workspaceManifests
      .filter((manifest) => manifest.metadata.name !== 'gmail.send')
      .map((manifest) => ({
        pin: {
          kind: 'tool' as const,
          id: manifest.metadata.name,
          version: manifest.metadata.version,
        },
        reason: 'Bundled workspace tool',
      })),
  ]);
  return { ledger, enforcement: createSuspensionEnforcer({ ledger }) };
}

describe('dev connector authorization wiring', () => {
  it('opens Drive with the dev-stack published pin and blocks it after revocation', async () => {
    const h = harness();
    const { ledger, enforcement } = await publishedEnforcement();
    h.check.mockImplementation((...args) => enforcement.check(...args));
    await expect(h.deps.meeting.driveSearch('triage', authorizedCaller, 'task-1')).resolves.toEqual(
      [],
    );
    expect(h.openWorker).toHaveBeenCalledExactlyOnceWith('alice');

    await ledger.change(
      versionCommand({ kind: 'tool', id: 'drive.search', version: '1' }, 'revoked', 2),
      'operator',
      testAt,
    );
    h.openWorker.mockClear();
    await expect(
      h.deps.meeting.driveSearch('triage', authorizedCaller, 'task-1'),
    ).rejects.toMatchObject({ code: 'CAPABILITY_VERSION_REVOKED' });
    expect(h.openWorker).not.toHaveBeenCalled();
  });
  it.each(['docs.createDraft', 'calendar.listEvents'])(
    'authorizes %s with the dev-stack published workspace pin',
    async (tool) => {
      const h = harness();
      const { enforcement } = await publishedEnforcement();
      h.check.mockImplementation((...args) => enforcement.check(...args));
      await expect(h.deps.routes.authorizePreparation('alice', 'task-1', tool)).resolves.toBe(true);
    },
  );
  it.each(['calendar.listEvents', 'calendar.createEvent', 'gmail.createDraft'] as const)(
    'denies direct preparation and execution of non-admitted source: %s',
    async (tool) => {
      const h = harness();
      h.read.mockResolvedValue({ ...h.task, skillVersion: 'workspace-task' });
      h.context.allowedSources = ['docs'];
      expect(await h.deps.routes.authorizePreparation('alice', 'task-1', tool)).toBe(false);
      expect(
        await h.deps.broker.authorize({
          subject: 'alice',
          taskId: 'task-1',
          stepId: 'workspace',
          tool,
          payload: {},
          callId: 'direct-call',
          idempotencyKey: 'direct-call',
          traceId: 'trace',
        }),
      ).toMatchObject({ allowed: false });
      expect(h.check).not.toHaveBeenCalled();
    },
  );
  it('denies new preparation and execution on completed tasks', async () => {
    const h = harness();
    h.read.mockResolvedValue({ ...h.task, status: 'COMPLETED' });
    expect(await h.deps.routes.authorizePreparation('alice', 'task-1', 'docs.createDraft')).toBe(
      false,
    );
    expect(
      await h.deps.broker.authorize({
        subject: 'alice',
        taskId: 'task-1',
        stepId: 'workspace',
        tool: 'docs.createDraft',
        payload: {},
        callId: 'new-call',
        idempotencyKey: 'new-call',
        traceId: 'trace',
      }),
    ).toMatchObject({ allowed: false });
    expect(h.check).not.toHaveBeenCalled();
  });
  it('checks Drive suspension before opening the worker source', async () => {
    const h = harness();
    h.check.mockRejectedValueOnce(new Error('drive suspended'));
    await expect(h.deps.meeting.driveSearch('triage', authorizedCaller, 'task-1')).rejects.toThrow(
      'drive suspended',
    );
    expect(h.openWorker).not.toHaveBeenCalled();
    expect(h.check).toHaveBeenCalledWith(
      expect.objectContaining({ tool: { kind: 'tool', id: 'drive.search', version: '1' } }),
      'tool',
    );
    await h.deps.meeting.driveSearch(
      'triage',
      { ...authorizedCaller, caller: { ...authorizedCaller.caller, assertion: '' } },
      'task-1',
    );
    expect(h.openWorker).toHaveBeenCalledWith('alice');
  });
  it.each(['calendar.createEvent', 'gmail.searchThreads', 'gmail.createDraft'])(
    'authorizes %s through the published workspace task',
    async (tool) => {
      const h = harness();
      h.read.mockResolvedValue({ ...h.task, skillVersion: 'workspace-task' });
      expect(await h.deps.routes.authorizePreparation('alice', 'task-1', tool)).toBe(true);
      h.read.mockResolvedValue(undefined);
      expect(await h.deps.routes.authorizePreparation('bob', 'task-1', tool)).toBe(false);
    },
  );
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

import { describe, expect, it } from 'vitest';

import {
  draftPayload,
  eventPayload,
  fixtureNow,
  workspaceHarness,
} from '../connectors/test-fixtures.js';
import { acceptInput } from '../ports/dispatch-port.contract.js';
import { createMemoryDispatchHarness } from '../ports/memory/dispatch-port.js';

import { createMeetingPrepSkill } from './meeting-prep.js';
import { createSkillRegistry } from './registry.js';
import { createTaskDispatcher } from './task-dispatcher.js';
import { createWorkspaceTaskSkill } from './workspace-task.js';

import type { TaskSubmit } from '@agent-works/domain';

const cases = [
  { tool: 'calendar.createEvent', payload: eventPayload },
  { tool: 'gmail.createDraft', payload: draftPayload },
  { tool: 'gmail.searchThreads', payload: { query: 'Meeting', limit: 10 } },
];
describe('workspace task dispatcher workflows', () => {
  it.each(cases)(
    'executes $tool through an authorized task and bound approval when required',
    async ({ tool, payload }) => {
      const h = await workspaceHarness();
      try {
        const task = createWorkspaceTaskSkill(() => ({
          broker: h.broker,
          approvals: h.approvals,
          now: () => fixtureNow,
        }));
        const request: TaskSubmit = {
          ...acceptInput.request,
          skillId: 'workspace-task',
          input: { tool, payload },
          sourceAllowlist: [tool.split('.')[0]],
        };
        expect(task.validate(request)).toBe(true);
        const harness = createMemoryDispatchHarness();
        harness.setNow(fixtureNow.toISOString());
        const ports = harness.open();
        const accepted = await ports.dispatch.accept({
          ...acceptInput,
          request,
          agent: {
            ...acceptInput.agent,
            kind: 'agent',
            agentId: 'workspace-task',
            version: '1.0.0',
            identityRef: 'agent://workspace-task',
          },
          context: { ...acceptInput.context, allowedSources: request.sourceAllowlist },
          deadline: new Date(fixtureNow.getTime() + 60_000).toISOString(),
        });
        const deps = {
          registry: createSkillRegistry([task]),
          approvals: h.approvals,
          now: () => fixtureNow,
        };
        await createTaskDispatcher({ ...ports, ...deps }).runOnce();
        const pending = task.result(accepted.taskId);
        if (tool !== 'gmail.searchThreads') {
          if (pending?.kind !== 'approval-required') throw new Error('missing approval');
          expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
            status: 'WAITING_APPROVAL',
          });
          await h.approvals.bind(pending.approvalId, {
            actorSub: 'approver',
            decision: 'approve',
            expectedPayloadSha256: pending.payloadSha256,
          });
          harness.setNow(new Date(fixtureNow.getTime() + 1000).toISOString());
          const restarted = createWorkspaceTaskSkill(() => ({
            broker: h.broker,
            approvals: h.approvals,
            now: () => fixtureNow,
          }));
          await createTaskDispatcher({
            ...harness.restart(),
            ...deps,
            registry: createSkillRegistry([restarted]),
          }).runOnce();
        }
        expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
          status: 'COMPLETED',
        });
        expect(
          h.audit.some((event) => event.tool === tool && event.type === 'tool.completed'),
        ).toBe(tool !== 'gmail.searchThreads');
      } finally {
        await h.close();
      }
    },
  );
  it.each(['approve', 'reject'] as const)(
    'persists meeting approval discovery and continues after restart: %s',
    async (decision) => {
      const h = await workspaceHarness();
      try {
        const harness = createMemoryDispatchHarness();
        harness.setNow(fixtureNow.toISOString());
        const ports = harness.open();
        const request: TaskSubmit = {
          ...acceptInput.request,
          skillId: 'meeting-prep',
          sourceAllowlist: ['drive', 'calendar'],
          input: {
            title: 'Brief',
            destinationId: 'alice-folder',
            query: 'meeting',
            timeMin: '2026-10-15T00:00:00Z',
            timeMax: '2026-10-16T00:00:00Z',
          },
        };
        const accepted = await ports.dispatch.accept({
          ...acceptInput,
          request,
          agent: {
            kind: 'agent',
            agentId: 'meeting-prep',
            version: '1.0.0',
            identityRef: 'agent://meeting-prep',
          },
          context: { ...acceptInput.context, allowedSources: request.sourceAllowlist },
          deadline: new Date(fixtureNow.getTime() + 60_000).toISOString(),
        });
        let drafts = 0;
        const config = () => ({
          broker: h.broker,
          approvals: h.approvals,
          now: () => fixtureNow,
          driveSearch: () => Promise.resolve([]),
          draft: () => {
            drafts++;
            return Promise.resolve('Brief');
          },
        });
        const deps = { approvals: h.approvals, now: () => fixtureNow };
        await createTaskDispatcher({
          ...ports,
          ...deps,
          registry: createSkillRegistry([createMeetingPrepSkill(config)]),
        }).runOnce();
        const events = await ports.ledger.events('alice', accepted.taskId);
        const approvalId = events.find((event) => event.event.eventType === 'task.waiting_approval')
          ?.event.approvalId;
        if (!approvalId) throw new Error('missing approval event');
        const approval = await h.approvals.read(approvalId);
        if (!approval) throw new Error('missing persisted approval');
        expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
          status: 'WAITING_APPROVAL',
        });
        expect(await ports.ledger.events('bob', accepted.taskId)).toEqual([]);
        harness.setNow(new Date(fixtureNow.getTime() + 1000).toISOString());
        await createTaskDispatcher({
          ...harness.restart(),
          ...deps,
          registry: createSkillRegistry([createMeetingPrepSkill(config)]),
        }).runOnce();
        expect(h.docs.documents()).toEqual([]);
        expect(drafts).toBe(1);
        await h.approvals.bind(approvalId, {
          actorSub: 'approver',
          decision,
          expectedPayloadSha256: approval.payloadSha256,
        });
        harness.setNow(new Date(fixtureNow.getTime() + 2000).toISOString());
        await createTaskDispatcher({
          ...harness.restart(),
          ...deps,
          registry: createSkillRegistry([createMeetingPrepSkill(config)]),
        }).runOnce();
        expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
          status: decision === 'approve' ? 'COMPLETED' : 'CANCELLED',
        });
        expect(h.docs.documents()).toHaveLength(decision === 'approve' ? 1 : 0);
        expect(drafts).toBe(1);
      } finally {
        await h.close();
      }
    },
  );
});

import { scheduleFixture, eventTriggerFixture, scheduleHash } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../scripts/spec.mjs';
import {
  validateOperationBody,
  validateOperationHeaders,
  validateResponse,
} from '../dist/validation.js';

const spec = buildSpec();
const schedule = scheduleFixture();
const trigger = eventTriggerFixture(schedule.id);
const record = {
  spec: schedule,
  digest: scheduleHash(schedule),
  state: 'active',
  revision: 1,
  createdAt: schedule.timing.anchor,
  updatedAt: schedule.timing.anchor,
  cursor: schedule.timing.anchor,
};
const hold = {
  commandId: schedule.id,
  target: { kind: 'record', id: 'artifact-1' },
  action: 'set',
  reasonRef: 'case-1',
};

describe('governance and scheduling route bindings', () => {
  it.each([
    ['post', '/v1/schedules', 'createSchedule', 'ScheduleSpec', 'ScheduleRecord', 201],
    ['post', '/v1/schedules/preview', 'previewSchedule', 'ScheduleSpec', 'SchedulePreview', 200],
    ['get', '/v1/schedules', 'listSchedules', null, 'ScheduleList', 200],
    ['get', '/v1/schedules/history', 'scheduleHistory', null, 'ScheduleHistory', 200],
    ['post', '/v1/schedules/change', 'changeSchedule', 'ScheduleChange', 'ScheduleRecord', 200],
    ['post', '/v1/schedules/runs', 'scheduleRuns', 'ScheduleLookup', 'ScheduleRuns', 200],
    [
      'post',
      '/v1/schedules/triggers',
      'createEventTrigger',
      'EventTriggerCreate',
      'ScheduleRecord',
      201,
    ],
    ['get', '/v1/schedules/triggers', 'listEventTriggers', null, 'EventTriggerList', 200],
    ['post', '/v1/events/ingest', 'ingestEvent', 'EventPayload', 'ScheduleRun', 202],
    ['get', '/v1/admin/governance/holds', 'listLegalHolds', null, 'LegalHoldList', 200],
    ['post', '/v1/admin/governance/holds', 'changeLegalHold', 'HoldCommand', 'LegalHold', 200],
    [
      'get',
      '/v1/admin/governance/deletions',
      'listDeletionRequests',
      null,
      'DeletionRequestList',
      200,
    ],
    [
      'post',
      '/v1/admin/governance/deletions',
      'createDeletionRequest',
      'DeletionCommand',
      'DeletionRequest',
      202,
    ],
    [
      'post',
      '/v1/admin/governance/deletions/process',
      'processDeletionRequest',
      'DeletionProcess',
      'DeletionRequest',
      200,
    ],
  ])(
    'binds %s %s to runtime request and response shapes',
    (method, path, id, request, response, status) => {
      const op = spec.paths[path][method];
      expect(op.operationId).toBe(id);
      expect(op.requestBody?.content['application/json'].schema.$ref).toBe(
        request ? `#/components/schemas/${request}` : undefined,
      );
      expect(op.responses[status].content['application/json'].schema.$ref).toBe(
        `#/components/schemas/${response}`,
      );
    },
  );

  it('validates schedules, triggers and the 201 creation response', () => {
    expect(validateOperationBody('createSchedule', schedule)).toBe(true);
    expect(validateOperationBody('previewSchedule', schedule)).toBe(true);
    expect(validateOperationBody('createEventTrigger', { schedule, trigger })).toBe(true);
    expect(
      validateOperationBody('changeSchedule', {
        id: schedule.id,
        expectedRevision: 1,
        action: 'pause',
      }),
    ).toBe(true);
    expect(
      validateOperationBody('changeSchedule', {
        id: schedule.id,
        expectedRevision: 0,
        action: 'pause',
      }),
    ).toBe(false);
    expect(validateResponse('createSchedule', 201, record)).toBe(true);
    expect(validateResponse('createEventTrigger', 201, record)).toBe(true);
    expect(validateResponse('listSchedules', 200, { schedules: [record] })).toBe(true);
  });

  it.each(['set', 'release'])('validates hold %s commands', (action) => {
    const command = { ...hold, action };
    expect(validateOperationBody('changeLegalHold', command)).toBe(true);
    expect(validateOperationBody('changeLegalHold', { ...command, actor: 'injected' })).toBe(false);
    expect(
      validateResponse('changeLegalHold', 200, {
        ...command,
        actor: 'officer',
        occurredAt: record.createdAt,
        sequence: 1,
      }),
    ).toBe(true);
  });

  it('validates deletion creation and list responses', () => {
    const command = { requestId: schedule.id, subject: 'alice', reasonRef: 'privacy' };
    const request = {
      ...command,
      actor: 'officer',
      requestedAt: record.createdAt,
      updatedAt: record.updatedAt,
      state: 'REQUESTED',
      rejectionRef: null,
      revision: 1,
    };
    expect(validateOperationBody('createDeletionRequest', command)).toBe(true);
    expect(validateResponse('createDeletionRequest', 202, request)).toBe(true);
    expect(validateResponse('listDeletionRequests', 200, { requests: [request] })).toBe(true);
    expect(validateResponse('createDeletionRequest', 202, command)).toBe(false);
  });

  it('requires every signature header and a scalar event payload', () => {
    const op = spec.paths['/v1/events/ingest'].post;
    expect(op.security).toEqual([]);
    const headers = Object.fromEntries(op.parameters.map(({ name }) => [name, 'signed-value']));
    expect(validateOperationHeaders('ingestEvent', headers)).toBe(true);
    for (const { name } of op.parameters) {
      const incomplete = { ...headers };
      delete incomplete[name];
      expect(validateOperationHeaders('ingestEvent', incomplete)).toBe(false);
    }
    expect(validateOperationBody('ingestEvent', { incidentId: 'inc-1' })).toBe(true);
    expect(validateOperationBody('ingestEvent', { incidentId: { nested: 'value' } })).toBe(false);
  });
});

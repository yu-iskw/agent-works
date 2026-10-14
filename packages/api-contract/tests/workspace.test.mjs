import { describe, expect, it } from 'vitest';
import { buildSpec } from '../scripts/spec.mjs';
import { validateOperationBody, validateResponse } from '../dist/validation.js';

const spec = buildSpec();
describe('workspace connector OpenAPI bindings', () => {
  it.each([
    ['execute', 'executeWorkspaceTool', 200],
    ['scopes', 'requestWorkspaceScopes', 200],
    ['approvals/prepare', 'prepareWorkspaceApproval', 201],
    ['approvals/read', 'readWorkspaceApproval', 200],
    ['approvals/decide', 'decideWorkspaceApproval', 200],
  ])('publishes %s with its actual success status', (path, id, status) => {
    const op = spec.paths[`/v1/connectors/${path}`].post;
    expect(op.operationId).toBe(id);
    expect(op['x-implemented']).toBe(true);
    expect(op.responses[String(status)].description).toBe('Successful response');
  });
  it('enforces caller-free commands and payload-bound decisions', () => {
    const command = {
      tool: 'docs.createDraft',
      payload: {},
      taskId: 'task',
      stepId: 'step',
      callId: 'call',
      idempotencyKey: 'key',
      traceId: 'trace',
    };
    expect(validateOperationBody('executeWorkspaceTool', command)).toBe(true);
    expect(validateOperationBody('executeWorkspaceTool', { ...command, subject: 'forged' })).toBe(
      false,
    );
    expect(
      validateOperationBody('decideWorkspaceApproval', {
        approvalId: 'approval',
        decision: 'approve',
        expectedPayloadSha256: 'a'.repeat(64),
      }),
    ).toBe(true);
    expect(
      validateOperationBody('decideWorkspaceApproval', {
        approvalId: 'approval',
        decision: 'approve',
      }),
    ).toBe(false);
  });
  it('validates receipts and classified source responses', () => {
    expect(validateResponse('executeWorkspaceTool', 200, { id: 'doc-1', kind: 'document' })).toBe(
      true,
    );
    const source = {
      id: 'event-1',
      title: 'wrapped title',
      body: 'wrapped body',
      classification: 'INTERNAL',
      authority: 'none',
    };
    expect(validateResponse('executeWorkspaceTool', 200, [source])).toBe(true);
    expect(
      validateResponse('executeWorkspaceTool', 200, [{ ...source, authority: 'system' }]),
    ).toBe(false);
  });
  it('fingerprints connector routes as well as the app route table', () => {
    expect(spec['x-route-fingerprints']['../connectors/routes.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(spec['x-route-fingerprints']['index.ts']).toMatch(/^[a-f0-9]{64}$/);
  });
});

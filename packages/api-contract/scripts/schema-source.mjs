import * as domain from '@agent-works/domain';
import * as workspace from '@agent-works/domain/workspace-tools';
import * as governance from '@agent-works/domain/data-governance';
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string', minLength: 1 };
function json(schema) {
  const result = schema.toJSONSchema({ target: 'draft-2020-12' });
  delete result.$schema;
  return result;
}
function arm(schema, kind) {
  const result = json(schema);
  const selected = (result.oneOf ?? result.anyOf).find(
    (row) => row.properties?.kind?.const === kind,
  );
  return { ...selected, ...(result.$defs ? { $defs: result.$defs } : {}) };
}

export function schemaComponents() {
  const sources = json(workspace.workspaceSourcesSchema);
  sources.items.properties.authority = { const: 'none', type: 'string' };
  sources.items.required.push('authority');
  const components = {
    WorkspaceExecute: json(workspace.workspaceExecuteSchema),
    WorkspaceDecision: json(workspace.workspaceDecisionSchema),
    WorkspaceApprovalRead: json(workspace.workspaceApprovalReadSchema),
    WorkspaceScopeRequest: json(workspace.workspaceScopeRequestSchema),
    WorkspaceResult: {
      oneOf: [json(workspace.workspaceReceiptSchema), sources],
    },
    WorkspaceApprovalPrepared: object({ approval: json(domain.approvalSchema), payload: {} }),
    WorkspaceApprovalDetail: object({ approval: json(domain.approvalSchema), payload: {} }),
    WorkspaceApprovalDecided: json(domain.approvalDecidedSchema),
    AskRequest: json(domain.askRequestSchema),
    AskResponse: json(domain.askResponseSchema),
    TaskSubmit: arm(domain.taskApiSchema, 'submit'),
    TaskAccepted: arm(domain.taskApiSchema, 'accepted'),
    Task: json(domain.taskSchema),
    TaskEvents: object({ events: { type: 'array', items: json(domain.outboxEventSchema) } }),
    TaskCancelled: object({ taskId: string, status: json(domain.taskStatusSchema) }),
    ApprovalDetail: arm(domain.approvalApiSchema, 'detail'),
    ApprovalDecide: arm(domain.approvalApiSchema, 'decide'),
    ApprovalDecided: arm(domain.approvalApiSchema, 'decided'),
    SkillList: object({ skills: { type: 'array', items: json(domain.skillManifestSchema) } }),
    OAuthConnections: json(domain.oauthConnectionsSchema),
    OAuthStart: arm(domain.oauthApiSchema, 'start'),
    OAuthStarted: arm(domain.oauthApiSchema, 'started'),
    OAuthConnection: arm(domain.oauthApiSchema, 'connection'),
    OAuthConnectRequest: {
      oneOf: [arm(domain.oauthApiSchema, 'start'), arm(domain.oauthApiSchema, 'callback')],
    },
    OAuthConnectResponse: {
      oneOf: [arm(domain.oauthApiSchema, 'started'), arm(domain.oauthApiSchema, 'connection')],
    },
    SuspensionCommand: json(domain.suspensionCommandSchema),
    CapabilityVersionCommand: json(domain.capabilityVersionCommandSchema),
    SuspensionSnapshot: json(domain.suspensionSnapshotSchema),
    SuspensionHistory: json(domain.suspensionHistorySchema),
    SuspensionResult: json(domain.suspensionResultSchema),
    ScheduleSpec: json(domain.scheduleSpecSchema),
    ScheduleRecord: json(domain.scheduleRecordSchema),
    ScheduleList: object({
      schedules: { type: 'array', items: json(domain.scheduleRecordSchema) },
    }),
    SchedulePreview: object({
      allowed: { type: 'boolean' },
      maxPrivilege: json(domain.schedulePrivilegeSchema),
      authority: json(domain.schedulePrivilegeSchema),
    }),
    ScheduleHistory: object({ events: { type: 'array', items: json(domain.scheduleAuditSchema) } }),
    ScheduleChange: object({
      id: { type: 'string', format: 'uuid' },
      expectedRevision: { type: 'integer', minimum: 1 },
      action: { type: 'string', enum: ['pause', 'resume', 'revoke'] },
    }),
    ScheduleLookup: object({ id: { type: 'string', format: 'uuid' } }),
    ScheduleRun: json(domain.scheduleRunSchema),
    ScheduleRuns: object({ runs: { type: 'array', items: json(domain.scheduleRunSchema) } }),
    EventTriggerCreate: json(domain.eventTriggerCreateSchema),
    EventTriggerList: object({
      triggers: { type: 'array', items: json(domain.eventTriggerSchema) },
    }),
    EventPayload: {
      type: 'object',
      additionalProperties: {
        anyOf: [{ type: 'string', maxLength: 8192 }, { type: 'number' }, { type: 'boolean' }],
      },
    },
    HoldCommand: json(governance.holdCommandSchema),
    LegalHold: json(governance.legalHoldSchema),
    LegalHoldList: object({ holds: { type: 'array', items: json(governance.legalHoldSchema) } }),
    DeletionCommand: json(governance.deletionCommandSchema),
    DeletionRequest: json(governance.deletionRequestSchema),
    DeletionRequestList: object({
      requests: { type: 'array', items: json(governance.deletionRequestSchema) },
    }),
    DeletionProcess: object({ requestId: { type: 'string', format: 'uuid' } }),
    Error: object({ error: string }),
  };
  function rewrite(value) {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== '$defs')
          .map(([key, bit]) => [
            key,
            key === '$ref' && bit.startsWith('#/$defs/')
              ? '#/components/schemas/JsonValue'
              : rewrite(bit),
          ]),
      );
    return value;
  }
  components.JsonValue = {
    anyOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: { $ref: '#/components/schemas/JsonValue' } },
      { type: 'object', additionalProperties: { $ref: '#/components/schemas/JsonValue' } },
    ],
  };
  return rewrite(components);
}

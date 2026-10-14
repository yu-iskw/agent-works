import * as domain from '../../domain/dist/index.js';
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
  const components = {
    AskRequest: json(domain.askRequestSchema),
    AskResponse: json(domain.askResponseSchema),
    TaskSubmit: arm(domain.taskApiSchema, 'submit'),
    TaskAccepted: arm(domain.taskApiSchema, 'accepted'),
    Task: json(domain.taskSchema),
    TaskEvents: object({ events: { type: 'array', items: json(domain.auditEventSchema) } }),
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

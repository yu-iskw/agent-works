import { describe, expect, it } from 'vitest';

import { botDefinitionSchema, parseBotProposal, validateBotDefinition } from './bot-definition.js';

import type {
  BotDefinition,
  BotStep,
  BotValidationContext,
  SkillResolution,
} from './bot-definition.js';

const pin = {
  packageId: 'curated/research',
  version: '1.2.3',
  digest: 'a'.repeat(64),
  name: 'research',
};
const read: BotStep = {
  id: 'read',
  title: 'Read documents',
  kind: 'connector_read',
  dependsOn: [],
  capability: 'drive.read',
  query: 'Find changes',
};
const result: BotStep = {
  id: 'result',
  title: 'Send result',
  kind: 'result',
  dependsOn: ['read'],
  from: 'read',
};
const definition = (steps: BotStep[] = [read, result]): BotDefinition => ({
  apiVersion: 'agent-works.bot/v1',
  name: 'Daily review',
  purpose: 'Review changes',
  planning: { mode: 'fixed' },
  workflow: { steps },
  triggers: [{ kind: 'manual' }],
  approvals: { mode: 'per_run' },
  limits: {
    maxConcurrentRunsPerBot: 1,
    maxConcurrentRunsPerUser: 1,
    runTimeoutMinutes: 60,
    maxCostMicros: null,
  },
  result: { destination: 'inbox' },
});
const context: BotValidationContext = {
  segmentCapabilities: new Set(['drive.read']),
  approvedAgents: {
    get: (agentId) =>
      agentId === 'reviewer'
        ? {
            agentId,
            displayName: 'Reviewer',
            protocol: 'mcp',
            dataClassification: 'INTERNAL',
            supports: { cancel: true, lookupByIdempotencyKey: true, reportsCost: false },
          }
        : undefined,
  },
  skills: {
    resolve: (ref) =>
      Promise.resolve({
        ok: true,
        skill: {
          ...ref,
          description: 'Research',
          instructions: 'Read',
          allowedTools: ['drive.read'],
          provenance: { source: 'curated', path: 'research', loadedAt: '2026-11-04T00:00:00.000Z' },
        },
      }),
  },
};
const codes = async (input: unknown, ctx = context) =>
  (await validateBotDefinition(input, ctx)).map((d) => d.code);

describe('bot definition boundary', () => {
  it('accepts strict fixed workflows and never throws for malformed model output', () => {
    expect(parseBotProposal(definition())).toMatchObject({ success: true });
    for (const input of [
      null,
      {},
      undefined,
      { ...definition(), extra: true },
      {
        get apiVersion() {
          throw new Error('getter');
        },
      },
    ]) {
      const parsed = parseBotProposal(input);
      expect(parsed.success).toBe(false);
      expect(parsed).toHaveProperty(
        'diagnostics',
        expect.arrayContaining([expect.objectContaining({ code: 'invalid_schema' })]),
      );
    }
  });
  it('rejects unsupported planning, protocol, writes, and invalid IANA timezones specifically', async () => {
    expect(await codes({ ...definition(), planning: { mode: 'dynamic' } })).toContain(
      'unsupported_planning_mode',
    );
    expect(
      await codes(
        definition([{ ...read, kind: 'connector_read', capability: 'docs.publish' }, result]),
      ),
    ).toContain('write_capability');
    const delegate = {
      id: 'delegate',
      title: 'Ask reviewer',
      dependsOn: ['read'],
      kind: 'mcp_delegate',
      agent: { agentId: 'reviewer', protocol: 'a2a' },
      instruction: 'Review',
      inputs: ['read'],
      timeoutSeconds: 60,
    };
    expect(
      await codes({
        ...definition(),
        workflow: {
          steps: [read, delegate, { ...result, dependsOn: ['delegate'], from: 'delegate' }],
        },
      }),
    ).toContain('unsupported_protocol');
    expect(
      await codes({
        ...definition(),
        triggers: [
          {
            kind: 'schedule',
            timezone: 'Moon/Base',
            timing: { kind: 'cron', expression: '0 9 * * *' },
            missedRun: 'skip',
          },
        ],
      }),
    ).toContain('invalid_timezone');
  });
  it.each([
    ['duplicate_step_id', [read, { ...result, id: 'read' }]],
    ['dangling_reference', [read, { ...result, dependsOn: ['missing'], from: 'missing' }]],
    ['cycle', [{ ...read, dependsOn: ['result'] }, result]],
    ['reference_not_earlier', [result, read]],
    ['result_count', [read, result, { ...result, id: 'result_two' }]],
    ['unreachable_step', [read, { ...read, id: 'orphan' }, result]],
    ['result_not_sink', [read, result, { ...read, id: 'after', dependsOn: ['result'] }]],
    [
      'input_not_dependency',
      [
        read,
        { id: 'use', title: 'Use', kind: 'skill', dependsOn: [], inputs: ['read'], skill: pin },
        { ...result, dependsOn: ['read', 'use'] },
      ],
    ],
  ] satisfies [string, BotStep[]][])('rejects invalid graphs with %s', async (code, steps) => {
    expect(await codes(definition(steps))).toContain(code);
  });
  it('refuses a BigQuery bot step even when the segment allows the capability (T7-05)', async () => {
    const bigquery = { ...read, capability: 'bigquery.query' as const };
    expect(
      await codes(definition([bigquery, { ...result, from: 'read' }]), {
        ...context,
        segmentCapabilities: new Set(['bigquery.query']),
      }),
    ).toEqual(['unsupported_connector']);
  });
  it('requires checkpoint-approved data to be upstream of the checkpoint (T7-03, T8-01, T8-03)', async () => {
    const check = (id: string, dependsOn: string[]): BotStep => ({
      id,
      title: id,
      kind: 'approval',
      dependsOn,
      prompt: `${id}?`,
    });
    const second = { ...read, id: 'read2', dependsOn: ['read'] };
    // A sibling read consumed after the checkpoint, and a root checkpoint, are refused.
    expect(
      await codes(
        definition([
          read,
          check('approval', ['read']),
          second,
          { ...result, dependsOn: ['approval', 'read2'], from: 'read2' },
        ]),
      ),
    ).toEqual(['checkpoint_input_not_upstream']);
    expect(
      await codes(
        definition([check('approval', []), read, { ...result, dependsOn: ['approval', 'read'] }]),
      ),
    ).toEqual(['checkpoint_input_not_upstream']);
    // Data upstream of the checkpoint, and checkpoints that only gate other checkpoints, are valid.
    expect(
      await codes(
        definition([
          read,
          second,
          check('approval', ['read', 'read2']),
          { ...result, dependsOn: ['approval', 'read2'], from: 'read2' },
        ]),
      ),
    ).toEqual([]);
    expect(
      await codes(
        definition([
          read,
          check('a', ['read']),
          check('b', ['read']),
          { ...read, id: 'after', dependsOn: ['a', 'b'] },
          { ...result, dependsOn: ['after'], from: 'after' },
        ]),
      ),
    ).toEqual([]);
  });
  it('refuses an approval as a data source (T9-01)', async () => {
    const check: BotStep = {
      id: 'approval',
      title: 'Review',
      kind: 'approval',
      dependsOn: [],
      prompt: 'Approve?',
    };
    expect(
      await codes(definition([check, { ...result, dependsOn: ['approval'], from: 'approval' }])),
    ).toContain('approval_not_data');
    expect(
      await codes(
        definition([
          read,
          { ...check, dependsOn: ['read'] },
          {
            id: 'use',
            title: 'Use',
            kind: 'skill',
            dependsOn: ['approval'],
            inputs: ['approval'],
            skill: pin,
          },
          { ...result, dependsOn: ['use'], from: 'use' },
        ]),
      ),
    ).toContain('approval_not_data');
    // An approval stays a valid dependency when the data comes from the step it approves.
    expect(
      await codes(
        definition([
          read,
          { ...check, dependsOn: ['read'] },
          { ...result, dependsOn: ['approval'], from: 'read' },
        ]),
      ),
    ).toEqual([]);
  });
  it('checks segment policy and the approved registry', async () => {
    expect(await codes(definition(), { ...context, segmentCapabilities: new Set() })).toContain(
      'capability_not_allowed',
    );
    expect(
      await codes(
        definition([
          read,
          {
            id: 'delegate',
            title: 'Ask',
            dependsOn: ['read'],
            kind: 'mcp_delegate',
            agent: { agentId: 'unknown', protocol: 'mcp' },
            instruction: 'Review',
            inputs: ['read'],
            timeoutSeconds: 60,
          },
          { ...result, dependsOn: ['delegate'], from: 'delegate' },
        ]),
      ),
    ).toContain('unknown_agent');
  });
  const skillDefinition = () =>
    definition([
      read,
      {
        id: 'use',
        title: 'Use skill',
        kind: 'skill',
        dependsOn: ['read'],
        inputs: ['read'],
        skill: pin,
      },
      { ...result, dependsOn: ['use'], from: 'use' },
    ]);
  it.each([
    'unknown_package',
    'unknown_version',
    'digest_mismatch',
    'unknown_skill',
    'not_activated',
  ] as const)('preserves resolver refusal %s', async (code) => {
    expect(
      await codes(skillDefinition(), {
        ...context,
        skills: { resolve: () => Promise.resolve({ ok: false, code }) },
      }),
    ).toContain(code);
  });
  it('checks actual resolved digests and forbids tool permission escalation', async () => {
    const resolve = async (digest: string, tools: string[]): Promise<SkillResolution> => {
      const resolved = await context.skills.resolve(pin);
      if (!resolved.ok) return resolved;
      return { ok: true, skill: { ...resolved.skill, digest, allowedTools: tools } };
    };
    expect(
      await codes(skillDefinition(), {
        ...context,
        skills: { resolve: () => resolve('b'.repeat(64), []) },
      }),
    ).toContain('digest_mismatch');
    expect(
      await codes(skillDefinition(), {
        ...context,
        skills: { resolve: () => resolve(pin.digest, ['notes.write']) },
      }),
    ).toContain('permission_escalation');
    expect(await codes(skillDefinition())).toEqual([]);
  });
  it('accepts semver prereleases and build metadata and rejects malformed pins', () => {
    for (const version of ['1.2.3', '0.0.0', '1.0.0-alpha.1+build.001']) {
      const def = skillDefinition();
      const skill = def.workflow.steps.find((step) => step.kind === 'skill');
      if (skill?.kind === 'skill') skill.skill.version = version;
      expect(botDefinitionSchema.safeParse(def).success).toBe(true);
    }
    for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3+', '1.2.3-', '1.2.3+one+two']) {
      const def = skillDefinition();
      const skill = def.workflow.steps.find((step) => step.kind === 'skill');
      if (skill?.kind === 'skill') skill.skill.version = version;
      expect(botDefinitionSchema.safeParse(def).success).toBe(false);
    }
  });
  it('reuses interval, cron, and window bounds and requires missed-run policy', () => {
    const schedule = {
      kind: 'schedule',
      timezone: 'Asia/Tokyo',
      timing: { kind: 'interval', everySeconds: 60, anchor: '2026-11-04T00:00:00Z' },
      allowedWindow: { weekdays: [1, 2], start: '09:00', end: '17:00' },
      missedRun: 'run_once',
    };
    expect(botDefinitionSchema.safeParse({ ...definition(), triggers: [schedule] }).success).toBe(
      true,
    );
    expect(
      botDefinitionSchema.safeParse({
        ...definition(),
        triggers: [{ ...schedule, timezone: '+01:00' }],
      }).success,
    ).toBe(false);
    expect(
      botDefinitionSchema.safeParse({
        ...definition(),
        triggers: [{ ...schedule, missedRun: undefined }],
      }).success,
    ).toBe(false);
    expect(
      botDefinitionSchema.safeParse({ ...definition(), workflow: { steps: [read] } }).success,
    ).toBe(false);
    expect(
      botDefinitionSchema.safeParse({
        ...definition(),
        limits: { ...definition().limits, maxConcurrentRunsPerBot: 6 },
      }).success,
    ).toBe(false);
  });
});

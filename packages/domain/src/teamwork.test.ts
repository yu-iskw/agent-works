import { describe, expect, it } from 'vitest';

import {
  checkSupport,
  claimNumbers,
  diffRevisions,
  isRequestedModel,
  missingSections,
} from './teamwork-evidence.js';
import { desiredInbox } from './teamwork-inbox.js';
import {
  capabilityStates,
  deniedSources,
  effectiveSet,
  repositoryAllowed,
  hasDependencyCycle,
} from './teamwork-policy.js';
import { inspectPortable, parsePortable, toPortable } from './teamwork-portable.js';
import {
  ASSIGNMENT_TRANSITIONS,
  CAPABILITIES,
  TEAMWORK_TRANSITIONS,
  canTeamworkTransition,
  portableDefinitionSchema,
} from './teamwork.js';

import type { InboxSnapshot } from './teamwork-inbox.js';
import type { ArtifactContent, Calculation, SkillDefinition } from './teamwork.js';

const all = new Set(CAPABILITIES);

describe('teamwork lifecycle tables', () => {
  it('only lets a plan dispatch work through approval', () => {
    const intoRunning = Object.entries(TEAMWORK_TRANSITIONS)
      .filter(([, to]) => to.includes('running'))
      .map(([from]) => from);
    expect(intoRunning).not.toContain('planning');
    expect(canTeamworkTransition('planning', 'running')).toBe(false);
    expect(canTeamworkTransition('plan_review', 'running')).toBe(true);
  });

  it('never publishes without passing through an action approval', () => {
    const intoPublishing = Object.entries(TEAMWORK_TRANSITIONS)
      .filter(([, to]) => to.includes('publishing'))
      .map(([from]) => from)
      .sort();
    expect(intoPublishing).toEqual(['awaiting_action_approval', 'failed', 'outcome_uncertain']);
  });

  it('keeps terminal states terminal', () => {
    expect(TEAMWORK_TRANSITIONS.cancelled).toEqual([]);
    expect(TEAMWORK_TRANSITIONS.declined).toEqual([]);
    expect(ASSIGNMENT_TRANSITIONS.cancelled).toEqual([]);
    expect(ASSIGNMENT_TRANSITIONS.superseded).toEqual([]);
  });

  it('names only known states in every edge', () => {
    for (const targets of Object.values(TEAMWORK_TRANSITIONS))
      for (const target of targets) expect(Object.keys(TEAMWORK_TRANSITIONS)).toContain(target);
  });
});

describe('effective capabilities', () => {
  it('is the intersection of segment, member, teammate, connection and task', () => {
    const states = capabilityStates({
      segment: new Set(['drive.read', 'docs.publish', 'bigquery.query']),
      member: new Set(['drive.read', 'bigquery.query', 'github.read']),
      teammate: new Set(['drive.read', 'github.read', 'bigquery.query']),
      connected: new Set(['google']),
      task: new Set(['drive.read', 'github.read']),
    });
    expect([...effectiveSet(states)]).toEqual(['drive.read']);
    const reasons = Object.fromEntries(states.map((s) => [s.capability, s.reason]));
    expect(reasons['docs.publish']).toMatch(/does not request/);
    expect(reasons['bigquery.query']).toMatch(/Not needed/);
    expect(reasons['github.read']).toMatch(/segment does not allow/);
  });

  it('cannot be widened by an imported teammate that requests everything', () => {
    const states = capabilityStates({
      segment: new Set(['drive.read']),
      member: all,
      teammate: all,
      connected: new Set(['google', 'github']),
    });
    expect([...effectiveSet(states)]).toEqual(['drive.read']);
  });

  it('explains which sources are denied and why', () => {
    const states = capabilityStates({
      segment: all,
      member: all,
      teammate: all,
      connected: new Set(['google']),
    });
    expect(deniedSources(['drive_research', 'github_code'], states)).toEqual([
      {
        source: 'github_code',
        capability: 'github.read',
        reason: 'Connect GitHub in this segment.',
      },
    ]);
  });

  it('matches repositories exactly against the allowlist', () => {
    expect(repositoryAllowed('Yu-Iskw/Agent-Works', ['yu-iskw/agent-works'])).toBe(true);
    expect(repositoryAllowed('yu-iskw/agent-works-fork', ['yu-iskw/agent-works'])).toBe(false);
  });
});

const sources = new Map([
  [
    'E1',
    {
      id: 'E1',
      title: 'Togglr feature-flag service evaluation',
      excerpt:
        'List price: USD 800 per month for 50 seats. Published uptime SLA: 99.9%. EU data residency: available in eu-west-1.',
    },
  ],
  [
    'E2',
    {
      id: 'E2',
      title: 'Security review notes',
      excerpt: 'Requirement: any vendor must support EU data residency before 2027-03-31.',
    },
  ],
]);

const calc: Calculation = {
  id: 'C1',
  metric: 'signups',
  unit: 'accounts',
  group: 'EU',
  groupBy: 'region',
  baseline: '2026-09',
  current: '2026-10',
  baselineValue: 14881,
  currentValue: 12754,
  change: -2127,
  changePct: -14.3,
  query: 'monthly_by_group',
  evidenceId: 'E3',
};
const calcs = new Map([['C1', calc]]);

describe('claim support', () => {
  const fact = (text: string, evidenceIds: string[] = ['E1'], calculationIds: string[] = []) => ({
    kind: 'fact' as const,
    text,
    evidenceIds,
    calculationIds,
  });

  it('accepts a claim whose numbers and wording are in the cited source', () => {
    expect(
      checkSupport(fact('Togglr lists USD 800 per month and a 99.9% uptime SLA.'), sources, calcs)
        .support,
    ).toBe('supported');
  });

  it('rejects a number the cited source does not contain', () => {
    const result = checkSupport(fact('Togglr costs USD 600 per month.'), sources, calcs);
    expect(result).toEqual({
      support: 'unsupported',
      reason: '600 does not appear in the cited sources.',
    });
  });

  it('rejects a claim citing a source that does not discuss it', () => {
    expect(
      checkSupport(fact('Flagship passed every penetration test.', ['E2']), sources, calcs).support,
    ).toBe('unsupported');
  });

  it('rejects a date absent from the source', () => {
    expect(
      checkSupport(fact('EU data residency is required before 2026-12-31.', ['E2']), sources, calcs)
        .support,
    ).toBe('unsupported');
  });

  it('rejects a material claim with no citation at all', () => {
    expect(checkSupport(fact('Togglr is cheaper.', []), sources, calcs).support).toBe(
      'unsupported',
    );
  });

  it('checks calculation numbers within the declared tolerance', () => {
    const ok = {
      kind: 'calculation' as const,
      text: 'EU signups fell 14.3% from 14,881 to 12,754.',
      evidenceIds: [],
      calculationIds: ['C1'],
    };
    expect(checkSupport(ok, sources, calcs).support).toBe('supported');
    const off = { ...ok, text: 'EU signups fell 16.0% from 14,881 to 12,754.' };
    expect(checkSupport(off, sources, calcs).support).toBe('unsupported');
  });

  it('does not require evidence for hypotheses and questions', () => {
    expect(
      checkSupport(
        {
          kind: 'hypothesis',
          text: 'The banner may hide the button.',
          evidenceIds: [],
          calculationIds: [],
        },
        sources,
        calcs,
      ).support,
    ).toBe('not_required');
  });

  it('ignores single list digits but keeps meaningful numbers', () => {
    expect(claimNumbers('Option 2 costs 1,200 and 99.95% on 2026-10-03')).toEqual([
      '1,200',
      '99.95%',
    ]);
  });
});

const content = (summary: string, lines: string[]): ArtifactContent => ({
  title: 'Brief',
  summary,
  sections: [
    {
      heading: 'Conclusion',
      statements: lines.map((text) => ({
        kind: 'fact',
        text,
        evidenceIds: ['E1'],
        calculationIds: [],
        support: 'supported',
      })),
    },
  ],
  limitations: [],
});

describe('revision diff', () => {
  it('reports statement and source changes per section', () => {
    const diff = diffRevisions(
      {
        content: content('A', ['Togglr SLA is 99.9%.', 'Choose Togglr.']),
        sources: ['Togglr evaluation'],
      },
      {
        content: content('A', ['Togglr SLA is unresolved: 99.9% or 99.5%.', 'Choose Togglr.']),
        sources: ['Togglr evaluation', 'Security review'],
      },
    );
    expect(diff.changedSections).toEqual(['Conclusion']);
    expect(diff.added).toEqual([
      { heading: 'Conclusion', text: 'Togglr SLA is unresolved: 99.9% or 99.5%.' },
    ]);
    expect(diff.removed).toEqual([{ heading: 'Conclusion', text: 'Togglr SLA is 99.9%.' }]);
    expect(diff.sourcesAdded).toEqual(['Security review']);
  });

  it('finds missing required sections', () => {
    expect(missingSections(content('A', []), ['Conclusion', 'Unresolved questions'])).toEqual([
      'Unresolved questions',
    ]);
  });
});

describe('model identity', () => {
  it('accepts the configured model and documented version suffixes only', () => {
    expect(isRequestedModel('gemini-3.8-flash', 'gemini-3.8-flash')).toBe(true);
    expect(isRequestedModel('gemini-3.8-flash', 'gemini-3.8-flash-001')).toBe(true);
    expect(isRequestedModel('gemini-3.8-flash', 'gemini-3.8-flash-lite')).toBe(false);
    expect(isRequestedModel('gemini-3.8-flash', 'gemini-2.5-flash')).toBe(false);
    expect(isRequestedModel('gemini-3.8-flash', 'gemini-3.8-flash-preview-99')).toBe(false);
  });
});

const skill: SkillDefinition = {
  name: 'Evidence-first comparison',
  summary: 'Compare alternatives using only cited sources.',
  workflows: ['research_brief'],
  applicability: 'Decisions between named alternatives.',
  inputs: [{ name: 'question', description: 'The decision to make', required: true }],
  steps: ['List alternatives', 'Compare on criteria'],
  validation: ['Every fact cites a source'],
  outputSections: ['Alternatives', 'Conclusion'],
  missingData: 'Say what is missing.',
  approvalBoundary: 'Never publish without approval.',
  capabilities: ['drive.read'],
};

describe('portable definitions', () => {
  const canaryToken = ['ya29', 'a0AfB_canary_access_token_value'].join('.');
  const portable = toPortable({
    name: 'Research analyst',
    role: 'Finds and weighs evidence',
    instructions: 'Be precise.',
    capabilityRequests: ['drive.read'],
    skills: [skill],
  });

  it('contains only allowlisted keys', () => {
    expect(Object.keys(portable).sort()).toEqual(
      [
        'capabilityRequests',
        'format',
        'instructions',
        'kind',
        'name',
        'parameters',
        'role',
        'skills',
      ].sort(),
    );
    expect(portable.parameters).toEqual([
      { name: 'question', description: 'The decision to make' },
    ]);
  });

  it('flags secrets, emails and known private identifiers', () => {
    const leaky = {
      ...portable,
      instructions: `Use ${canaryToken} and folder 1AbCdEfGhIjKlMnOp for member@example.com`,
    };
    const kinds = inspectPortable(leaky, ['1AbCdEfGhIjKlMnOp'])
      .map((f) => f.kind)
      .sort();
    expect(kinds).toEqual(['email', 'private_identifier', 'secret']);
  });

  it('rejects imports that smuggle extra fields or secrets', () => {
    const smuggled = JSON.stringify({
      ...portable,
      connections: [{ provider: 'google', token: 'x' }],
    });
    expect(parsePortable(smuggled, [])).toMatchObject({ ok: false, error: 'invalid_definition' });
    const secret = JSON.stringify({ ...portable, role: `Use ${canaryToken}` });
    expect(parsePortable(secret, [])).toMatchObject({ ok: false, error: 'contains_secrets' });
    expect(parsePortable(JSON.stringify(portable), [])).toMatchObject({ ok: true });
    expect(portableDefinitionSchema.safeParse(portable).success).toBe(true);
  });
});

describe('inbox reducer', () => {
  const base: InboxSnapshot = {
    status: 'running',
    planVersion: 1,
    latestRevision: 0,
    version: 5,
    assignments: [],
    pendingApproval: null,
    publishedApproval: null,
  };

  it('has one plan review item bound to the plan version', () => {
    expect(desiredInbox({ ...base, status: 'plan_review', planVersion: 2 })).toEqual([
      expect.objectContaining({ kind: 'plan_review', ref: 'plan:2' }),
    ]);
  });

  it('asks about missing contributions without hiding successful ones', () => {
    const items = desiredInbox({
      ...base,
      status: 'needs_input',
      assignments: [
        { id: 'a', key: 'pricing', status: 'succeeded', attempt: 1, question: null },
        { id: 'b', key: 'risk', status: 'timed_out', attempt: 1, question: null },
      ],
    });
    expect(items).toEqual([expect.objectContaining({ kind: 'question', ref: 'missing:b.1' })]);
  });

  it('replaces the result item with the approval item, so one decision resolves both views', () => {
    expect(desiredInbox({ ...base, status: 'ready', latestRevision: 2 })[0]).toMatchObject({
      kind: 'completed',
      ref: 'revision:2',
    });
    expect(
      desiredInbox({ ...base, status: 'awaiting_action_approval', pendingApproval: { id: 'p' } }),
    ).toEqual([expect.objectContaining({ kind: 'approval', ref: 'approval:p' })]);
    expect(desiredInbox({ ...base, status: 'publishing' })).toEqual([]);
  });
});

describe('plan dependencies', () => {
  const plan = (edges: Record<string, string[]>) =>
    Object.entries(edges).map(([key, dependsOn]) => ({ key, dependsOn }));

  it('accepts chains and fan-in', () => {
    expect(hasDependencyCycle(plan({ a: [], b: ['a'], c: ['a', 'b'] }))).toBe(false);
  });

  it('finds direct, indirect and partial cycles', () => {
    expect(hasDependencyCycle(plan({ a: ['b'], b: ['a'] }))).toBe(true);
    expect(hasDependencyCycle(plan({ a: ['c'], b: ['a'], c: ['b'] }))).toBe(true);
    expect(hasDependencyCycle(plan({ free: [], a: ['b'], b: ['a'] }))).toBe(true);
  });
});

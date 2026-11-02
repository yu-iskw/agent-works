import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const matrixPath = 'docs/plans/enterprise-production-v1/fnd-01/readiness-matrix.json';
const phase3Path = 'docs/plans/phase3-readiness-matrix.md';

const DECISION_IDS = Array.from({ length: 12 }, (_, i) => `D-${String(i + 1).padStart(2, '0')}`);
const OPEN_ITEM_IDS = Array.from({ length: 8 }, (_, i) => `O${String(i + 1).padStart(2, '0')}`);

const PLACEHOLDER =
  /^(|-|n\/?a|none|null|tbd|tba|todo|pending|unknown|placeholder|approved|yes|x+|<[^>]*>|\[[^\]]*\]|y{4}-m{2}-d{2})$/i;

function isPlaceholder(value) {
  return typeof value !== 'string' || PLACEHOLDER.test(value.trim());
}

function readRepo(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function adrStatus(path) {
  const match = /^## Status\s+(\S+)/m.exec(readRepo(path));
  return match ? match[1] : undefined;
}

function phase3Facts() {
  const facts = new Map();
  for (const line of readRepo(phase3Path).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (/^D-\d\d$/.test(cells[1] ?? '')) {
      facts.set(cells[1], { recorded: cells[5], blocks: cells[6] });
    }
  }
  return facts;
}

function signoffProblems(entry, adrs) {
  const { signoff } = entry;
  if (signoff === null || signoff === undefined) {
    return [`${entry.id} is accepted without a signoff`];
  }
  const problems = [];
  for (const field of ['role', 'name', 'date', 'evidenceRef']) {
    if (isPlaceholder(signoff[field])) {
      problems.push(`${entry.id} signoff.${field} is a placeholder`);
    }
  }
  if (!problems.length) {
    if (!/^\d{4}-\d\d-\d\d$/.test(signoff.date) || Number.isNaN(Date.parse(signoff.date))) {
      problems.push(`${entry.id} signoff.date is not a real date`);
    }
    if (!existsSync(join(repoRoot, signoff.evidenceRef))) {
      problems.push(`${entry.id} signoff.evidenceRef does not exist`);
    }
  }
  const backing = (entry.partialRecords ?? []).map((p) => adrs.get(p));
  if (!backing.includes('Accepted')) {
    problems.push(`${entry.id} is accepted without an Accepted ADR`);
  }
  return problems;
}

function validateMatrix(matrix, { adrs, phase3 }) {
  const problems = [];
  const entries = [...matrix.decisions, ...matrix.openItems];

  for (const id of [...DECISION_IDS, ...OPEN_ITEM_IDS]) {
    if (!entries.some((e) => e.id === id)) problems.push(`${id} is missing`);
  }
  for (const entry of entries) {
    for (const field of ['ownerRole', 'status', 'blockingCapability', 'evidencePath']) {
      if (isPlaceholder(entry[field])) problems.push(`${entry.id} has no ${field}`);
    }
    if (!['open', 'accepted'].includes(entry.status)) {
      problems.push(`${entry.id} has unknown status ${entry.status}`);
    }
    if (!isPlaceholder(entry.evidencePath) && !existsSync(join(repoRoot, entry.evidencePath))) {
      problems.push(`${entry.id} evidencePath does not exist`);
    }
    if (entry.status === 'accepted') problems.push(...signoffProblems(entry, adrs));
    if (entry.status === 'open' && entry.signoff) {
      problems.push(`${entry.id} is open but carries a signoff`);
    }
  }

  for (const adr of matrix.adrs) {
    const actual = adrs.get(adr.file);
    if (actual !== adr.status) {
      problems.push(`ADR ${adr.id} is ${actual} in the repo but ${adr.status} in the matrix`);
    }
  }

  for (const decision of matrix.decisions) {
    const fact = phase3.get(decision.id);
    if (fact?.recorded === 'open' && decision.status !== 'open') {
      problems.push(`${decision.id} is open in ${phase3Path} but ${decision.status} here`);
    }
    for (const oid of decision.openItems) {
      const item = matrix.openItems.find((o) => o.id === oid);
      if (!item?.relatedDecisions.includes(decision.id)) {
        problems.push(`${decision.id} and ${oid} do not reference each other`);
      }
    }
  }
  return problems;
}

function load() {
  const matrix = JSON.parse(readRepo(matrixPath));
  const adrs = new Map(matrix.adrs.map((a) => [a.file, adrStatus(a.file)]));
  return { matrix, context: { adrs, phase3: phase3Facts() } };
}

const clone = (value) => structuredClone(value);

function withDecision(matrix, id, patch) {
  const next = clone(matrix);
  Object.assign(
    next.decisions.find((d) => d.id === id),
    patch,
  );
  return next;
}

const realSignoff = {
  role: 'Security / privacy',
  name: 'Test Approver',
  date: '2026-11-02',
  evidenceRef: 'docs/adr/0003-pilot-decisions.md',
};

describe('FND-01 readiness matrix on the recorded repository', () => {
  const { matrix, context } = load();

  test('passes validation and leaves every decision and open item open', () => {
    expect(validateMatrix(matrix, context)).toEqual([]);
    for (const entry of [...matrix.decisions, ...matrix.openItems]) {
      expect(entry.status).toBe('open');
      expect(entry.signoff).toBeNull();
    }
  });

  test('keeps ADRs 0004 to 0006 Proposed in the repo files', () => {
    for (const file of matrix.adrs.filter((a) => a.id >= '0004').map((a) => a.file)) {
      expect(context.adrs.get(file)).toBe('Proposed');
    }
  });

  test('covers D-01..D-12 and O01..O08 exactly once', () => {
    expect(matrix.decisions.map((d) => d.id)).toEqual(DECISION_IDS);
    expect(matrix.openItems.map((o) => o.id)).toEqual(OPEN_ITEM_IDS);
  });

  test('records the #23 closure gap against files that do not exist', () => {
    for (const artifact of matrix.issue23.promisedArtifacts) {
      expect(existsSync(join(repoRoot, artifact.path))).toBe(artifact.exists);
    }
  });
});

describe('FND-01 approval placeholders cannot pass', () => {
  const { matrix, context } = load();

  test.each([
    '',
    'TBD',
    'TODO',
    'pending',
    'N/A',
    'unknown',
    '<approver>',
    '[name]',
    'yyyy-mm-dd',
    'approved',
  ])('placeholder signer name %j is rejected', (name) => {
    const next = withDecision(matrix, 'D-01', {
      status: 'accepted',
      signoff: { ...realSignoff, name },
    });
    expect(validateMatrix(next, context)).toContain('D-01 signoff.name is a placeholder');
  });

  test.each([
    ['null signoff', null, 'D-01 is accepted without a signoff'],
    ['placeholder date', { ...realSignoff, date: 'TBD' }, 'D-01 signoff.date is a placeholder'],
    [
      'impossible date',
      { ...realSignoff, date: '2026-13-45' },
      'D-01 signoff.date is not a real date',
    ],
    ['missing role', { ...realSignoff, role: undefined }, 'D-01 signoff.role is a placeholder'],
    [
      'missing evidence file',
      { ...realSignoff, evidenceRef: 'docs/adr/9999-nothing.md' },
      'D-01 signoff.evidenceRef does not exist',
    ],
  ])('accepted with %s is rejected', (_label, signoff, expected) => {
    const next = withDecision(matrix, 'D-01', { status: 'accepted', signoff });
    expect(validateMatrix(next, context)).toContain(expected);
  });

  test('accepted with a Proposed ADR as its only backing is rejected', () => {
    const next = withDecision(matrix, 'D-01', {
      status: 'accepted',
      signoff: realSignoff,
      partialRecords: ['docs/adr/0004-application-core-and-adapter-boundaries.md'],
    });
    expect(validateMatrix(next, context)).toContain('D-01 is accepted without an Accepted ADR');
  });

  test('a complete signoff backed by an Accepted ADR is the only passing accepted shape', () => {
    const next = withDecision(matrix, 'D-01', { status: 'accepted', signoff: realSignoff });
    expect(validateMatrix(next, context)).toEqual([
      `D-01 is open in ${phase3Path} but accepted here`,
    ]);
    const agreeing = { ...context, phase3: new Map([['D-01', { recorded: 'recorded' }]]) };
    expect(validateMatrix(next, agreeing)).toEqual([]);
  });

  test('a signoff on an open decision is rejected', () => {
    const next = withDecision(matrix, 'D-02', { signoff: realSignoff });
    expect(validateMatrix(next, context)).toContain('D-02 is open but carries a signoff');
  });
});

describe('FND-01 structural failures', () => {
  const { matrix, context } = load();

  test('a Proposed ADR recorded as Accepted is rejected', () => {
    const next = clone(matrix);
    next.adrs.find((a) => a.id === '0005').status = 'Accepted';
    expect(validateMatrix(next, context)).toContain(
      'ADR 0005 is Proposed in the repo but Accepted in the matrix',
    );
  });

  test('a missing decision, owner role, blocking capability or evidence path is rejected', () => {
    const next = clone(matrix);
    next.decisions = next.decisions.filter((d) => d.id !== 'D-12');
    next.decisions[0].ownerRole = '';
    next.decisions[1].blockingCapability = 'TBD';
    next.decisions[2].evidencePath = 'docs/plans/no-such-file.md';
    expect(validateMatrix(next, context)).toEqual(
      expect.arrayContaining([
        'D-12 is missing',
        'D-01 has no ownerRole',
        'D-02 has no blockingCapability',
        'D-03 evidencePath does not exist',
      ]),
    );
  });

  test('a one-way decision to open-item link is rejected', () => {
    const next = clone(matrix);
    next.openItems.find((o) => o.id === 'O05').relatedDecisions = [];
    expect(validateMatrix(next, context)).toContain('D-10 and O05 do not reference each other');
  });
});

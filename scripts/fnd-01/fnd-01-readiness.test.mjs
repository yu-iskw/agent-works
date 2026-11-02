import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  matrixJsonPath,
  matrixMdPath,
  renderMatrix,
  repoRoot,
} from './render-readiness-matrix.mjs';

const phase3Path = 'docs/plans/phase3-readiness-matrix.md';

const DECISION_IDS = Array.from({ length: 12 }, (_, i) => `D-${String(i + 1).padStart(2, '0')}`);
const OPEN_ITEM_IDS = Array.from({ length: 8 }, (_, i) => `O${String(i + 1).padStart(2, '0')}`);

const PLACEHOLDER = new RegExp(
  `^(|-+|n\\.?/?a\\.?|none|null|undefined|tb[acd]|tbc|todo|pending|unknown|placeholder|approved|yes|ok|test|tester|foo|bar|lorem ipsum|to be (decided|confirmed|determined)|john doe|jane doe|claude|opus|sonnet|haiku|fable|gpt[-\\w.]*|gemini[-\\w.]*|grok[-\\w.]*|codex|cursor|copilot|ai|agent|bot|assistant|x+|<[^>]*>|\\[[^\\]]*\\]|y{4}-m{2}-d{2})$`,
  'i',
);

const isPlaceholder = (value) => typeof value !== 'string' || PLACEHOLDER.test(value.trim());

const readRepo = (path) => readFileSync(join(repoRoot, path), 'utf8');

function existsInRepo(path) {
  const rel = relative(repoRoot, join(repoRoot, path));
  return !isAbsolute(path) && !rel.startsWith('..') && existsSync(join(repoRoot, path));
}

function adrStatus(path) {
  return /^## Status\s+(\S+)/m.exec(readRepo(path))?.[1];
}

function phase3Facts(markdown) {
  const rows = markdown.split('\n').filter((l) => l.startsWith('|'));
  const split = (line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = rows.map(split).find((cells) => cells.includes('Id'));
  const column = (name) => {
    const index = header?.indexOf(name) ?? -1;
    if (index < 0) throw new Error(`${phase3Path} table has no "${name}" column`);
    return index;
  };
  const [idCol, recordedCol] = [column('Id'), column('Recorded fact')];
  const facts = new Map();
  for (const cells of rows.map(split)) {
    if (/^D-\d\d$/.test(cells[idCol])) facts.set(cells[idCol], cells[recordedCol]);
  }
  return facts;
}

function signoffProblems(entry, { adrs, decisionRecords }) {
  const { signoff } = entry;
  if (signoff === null || signoff === undefined) {
    return [`${entry.id} is accepted without a signoff`];
  }
  const problems = [];
  for (const field of ['role', 'name', 'date', 'evidenceRef']) {
    if (isPlaceholder(signoff[field]))
      problems.push(`${entry.id} signoff.${field} is a placeholder`);
  }
  if (
    typeof signoff.date === 'string' &&
    !problems.some((p) => p.endsWith('signoff.date is a placeholder'))
  ) {
    if (!/^\d{4}-\d\d-\d\d$/.test(signoff.date) || Number.isNaN(Date.parse(signoff.date))) {
      problems.push(`${entry.id} signoff.date is not a real date`);
    }
  }
  if (!isPlaceholder(signoff.evidenceRef)) {
    if (!decisionRecords.includes(signoff.evidenceRef)) {
      problems.push(`${entry.id} signoff.evidenceRef is not an ADR listed for this decision`);
    } else if (adrs.get(signoff.evidenceRef) !== 'Accepted') {
      problems.push(`${entry.id} signoff.evidenceRef is not an Accepted ADR`);
    }
  }
  return problems;
}

function validateMatrix(matrix, { adrs, phase3 }) {
  const problems = [];
  const entries = [...matrix.decisions, ...matrix.openItems];
  const recordsOf = (entry) =>
    entry.partialRecords ??
    entry.relatedDecisions.flatMap(
      (id) => matrix.decisions.find((d) => d.id === id)?.partialRecords ?? [],
    );

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
    if (!isPlaceholder(entry.evidencePath) && !existsInRepo(entry.evidencePath)) {
      problems.push(`${entry.id} evidencePath does not exist inside the repo`);
    }
    if (entry.status === 'accepted') {
      problems.push(...signoffProblems(entry, { adrs, decisionRecords: recordsOf(entry) }));
    }
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
    if (phase3.get(decision.id) === 'open' && decision.status !== 'open') {
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
  const matrix = JSON.parse(readRepo(matrixJsonPath));
  const adrs = new Map(matrix.adrs.map((a) => [a.file, adrStatus(a.file)]));
  return { matrix, context: { adrs, phase3: phase3Facts(readRepo(phase3Path)) } };
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
  name: 'Hanako Yamada',
  date: '2026-11-02',
  evidenceRef: 'docs/adr/0003-pilot-decisions.md',
};

describe('FND-01 readiness matrix on the recorded repository', () => {
  const { matrix, context } = load();

  test('passes validation with every entry open and unsigned', () => {
    expect(validateMatrix(matrix, context)).toEqual([]);
    for (const entry of [...matrix.decisions, ...matrix.openItems]) {
      expect(entry.status).toBe('open');
      expect(entry.signoff).toBeNull();
    }
  });

  test('keeps ADRs numbered 0004 and above Proposed in the repo files', () => {
    const later = matrix.adrs.filter((a) => Number(a.id) >= 4);
    expect(later.length).toBeGreaterThan(0);
    for (const { file } of later) expect(context.adrs.get(file)).toBe('Proposed');
  });

  test('readiness-matrix.md is up to date with the JSON (run render-readiness-matrix.mjs)', async () => {
    expect(readRepo(matrixMdPath)).toBe(await renderMatrix(matrix));
  });
});

describe('FND-01 approval placeholders cannot pass', () => {
  const { matrix, context } = load();

  test.each([
    '',
    'TBD',
    'TBC',
    'TODO',
    'pending',
    'N/A',
    'n.a.',
    'unknown',
    'to be decided',
    'test',
    'John Doe',
    'Claude',
    'Opus',
    'GPT-5',
    'Grok',
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
      'evidence that is not an ADR of this decision',
      { ...realSignoff, evidenceRef: 'docs/adr/0001-typescript-first-with-adk-js.md' },
      'D-01 signoff.evidenceRef is not an ADR listed for this decision',
    ],
    [
      'evidence that exists but is unrelated',
      { ...realSignoff, evidenceRef: 'package.json' },
      'D-01 signoff.evidenceRef is not an ADR listed for this decision',
    ],
  ])('accepted with %s is rejected', (_label, signoff, expected) => {
    const next = withDecision(matrix, 'D-01', { status: 'accepted', signoff });
    expect(validateMatrix(next, context)).toContain(expected);
  });

  test('accepted with a Proposed ADR as its only evidence is rejected', () => {
    const proposed = 'docs/adr/0004-application-core-and-adapter-boundaries.md';
    const next = withDecision(matrix, 'D-01', {
      status: 'accepted',
      signoff: { ...realSignoff, evidenceRef: proposed },
      partialRecords: [proposed],
    });
    expect(validateMatrix(next, context)).toContain(
      'D-01 signoff.evidenceRef is not an Accepted ADR',
    );
  });

  test('a complete signoff citing an Accepted ADR of the decision passes once Phase 3 agrees', () => {
    const next = withDecision(matrix, 'D-01', { status: 'accepted', signoff: realSignoff });
    expect(validateMatrix(next, context)).toEqual([
      `D-01 is open in ${phase3Path} but accepted here`,
    ]);
    const agreeing = { ...context, phase3: new Map([['D-01', 'recorded']]) };
    expect(validateMatrix(next, agreeing)).toEqual([]);
  });

  test('a signoff on an open decision is rejected', () => {
    const next = withDecision(matrix, 'D-02', { signoff: realSignoff });
    expect(validateMatrix(next, context)).toContain('D-02 is open but carries a signoff');
  });
});

describe('FND-01 structural guards', () => {
  const { matrix, context } = load();

  test('a Proposed ADR recorded as Accepted is rejected', () => {
    const next = clone(matrix);
    next.adrs.find((a) => a.id === '0005').status = 'Accepted';
    expect(validateMatrix(next, context)).toContain(
      'ADR 0005 is Proposed in the repo but Accepted in the matrix',
    );
  });

  test.each(['docs/plans/no-such-file.md', '../../../../etc/hosts', '/etc/hosts'])(
    'evidencePath %j outside or missing is rejected',
    (evidencePath) => {
      const next = withDecision(matrix, 'D-03', { evidencePath });
      expect(validateMatrix(next, context)).toContain(
        'D-03 evidencePath does not exist inside the repo',
      );
    },
  );

  test('a missing decision, owner role or blocking capability is rejected', () => {
    const next = clone(matrix);
    next.decisions = next.decisions.filter((d) => d.id !== 'D-12');
    next.decisions[0].ownerRole = '';
    next.decisions[1].blockingCapability = 'TBD';
    expect(validateMatrix(next, context)).toEqual(
      expect.arrayContaining([
        'D-12 is missing',
        'D-01 has no ownerRole',
        'D-02 has no blockingCapability',
      ]),
    );
  });

  test('a one-way decision to open-item link is rejected', () => {
    const next = clone(matrix);
    next.openItems.find((o) => o.id === 'O05').relatedDecisions = [];
    expect(validateMatrix(next, context)).toContain('D-10 and O05 do not reference each other');
  });

  test('phase 3 parsing fails loudly when a header is missing', () => {
    expect(() => phase3Facts('| Id | Question |\n| --- | --- |\n| D-01 | q |')).toThrow(
      /no "Recorded fact" column/,
    );
    expect(phase3Facts('| Id | Recorded fact |\n| --- | --- |\n| D-01 | open |').get('D-01')).toBe(
      'open',
    );
  });
});

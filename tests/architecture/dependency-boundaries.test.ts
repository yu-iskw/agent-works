import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  edgesOf,
  exceptions,
  importsOf,
  packageCycles,
  readRepository,
  violationsOf,
} from './boundaries.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

const workspaces = new Map([
  ['packages/domain', '@agent-works/domain'],
  ['packages/policy', '@agent-works/policy'],
  ['packages/agent-runtime', '@agent-works/agent-runtime'],
  ['packages/api-contract', '@agent-works/api-contract'],
  ['apps/api', '@agent-works/api'],
]);

const edgesFrom = (files: Record<string, string>) =>
  edgesOf(new Map(Object.entries(files)), workspaces);

const rulesBroken = (files: Record<string, string>) =>
  violationsOf(edgesFrom(files), []).violations.map((violation) => violation.rule);

describe('the repository', () => {
  const repo = readRepository(root, [
    'apps',
    'packages',
    'agents',
    'tools',
    'scripts',
    'e2e',
    'evals',
  ]);
  const edges = edgesOf(repo.files, repo.workspaces);

  it('scans the workspace packages it guards', () => {
    expect([...repo.workspaces.values()]).toEqual(
      expect.arrayContaining([
        '@agent-works/domain',
        '@agent-works/policy',
        '@agent-works/agent-runtime',
        '@agent-works/api-contract',
        '@agent-works/api',
      ]),
    );
    expect(edges.some((edge) => edge.from === 'apps/api/src/application/ask/ask-use-case.ts')).toBe(
      true,
    );
    expect(edges.some((edge) => edge.specifier === '@google/adk')).toBe(true);
  });

  it('respects every dependency boundary, with no stale exception', () => {
    expect(violationsOf(edges)).toEqual({ violations: [], unusedExceptions: [] });
  });

  it('has no cycles between workspace packages', () => {
    expect(packageCycles(edges)).toEqual([]);
  });

  it('documents every exception', () => {
    for (const exception of exceptions) expect(exception.reason.trim()).not.toBe('');
  });
});

describe('negative fixtures', () => {
  it.each([
    [
      'core-independent-of-apps',
      { 'packages/domain/src/a.ts': "import { x } from '../../../apps/api/src/http.js';" },
    ],
    ['core-independent-of-apps', { 'packages/policy/src/a.ts': "import '@agent-works/api';" }],
    [
      'adk-only-in-agent-runtime',
      { 'packages/policy/src/a.ts': "import type { LlmAgent } from '@google/adk';" },
    ],
    [
      'domain-independent-of-api-contract',
      { 'packages/domain/src/a.ts': "export * from '@agent-works/api-contract/transport';" },
    ],
    [
      'adk-only-in-agent-runtime',
      { 'apps/api/src/agent/a.ts': "const adk = await import('@google/adk');" },
    ],
    [
      'application-free-of-infrastructure',
      { 'apps/api/src/application/ask/a.ts': "import postgres from 'postgres';" },
    ],
    [
      'application-free-of-infrastructure',
      { 'apps/api/src/application/ask/a.ts': "import { createServer } from 'node:http';" },
    ],
    [
      'application-free-of-infrastructure',
      { 'apps/api/src/application/ask/a.ts': "import type { Route } from '../../http.js';" },
    ],
    [
      'application-free-of-infrastructure',
      {
        'apps/api/src/application/ask/a.ts':
          "import { createAdkRunner } from '@agent-works/agent-runtime';",
      },
    ],
    [
      'application-free-of-infrastructure',
      {
        'apps/api/src/application/ask/a.ts':
          "import { createPostgresAuditLog } from '../../audit/write.js';",
      },
    ],
    [
      'adk-only-in-agent-runtime',
      { 'apps/api/src/agent/a.cjs': "const adk = require('@google/adk');" },
    ],
    [
      'adk-only-in-agent-runtime',
      {
        'apps/api/src/agent/a.ts': [
          "const glob = 'packages/*';",
          "const adk = await import('@google/adk');",
          '/** a later block comment */',
        ].join('\n'),
      },
    ],
  ])('%s: %j', (rule, files) => {
    expect(rulesBroken(files)).toContain(rule);
  });

  const cycle = {
    'packages/domain/src/a.ts': "import { decide } from '@agent-works/policy';",
    'packages/policy/src/b.ts': "import { taskSchema } from '@agent-works/domain';",
  };

  it('finds a cycle between packages, including through a relative import', () => {
    expect(packageCycles(edgesFrom(cycle), [])).toEqual([
      ['@agent-works/domain', '@agent-works/policy', '@agent-works/domain'],
    ]);
    const relative = {
      'apps/api/src/a.ts': "import { x } from '@agent-works/policy';",
      'packages/policy/src/b.ts': "import { y } from '../../../apps/api/src/a.js';",
    };
    expect(packageCycles(edgesFrom(relative), [])).toEqual([
      ['@agent-works/api', '@agent-works/policy', '@agent-works/api'],
    ]);
  });

  it('flags stale exceptions, including a cycle exception that no longer closes a cycle', () => {
    const rule = { rule: 'adk-only-in-agent-runtime', from: 'x.ts', specifier: 'y', reason: 'r' };
    const cycleEdge = {
      rule: 'no-package-cycles',
      from: 'packages/policy/src/b.ts',
      specifier: '@agent-works/domain',
      reason: 'r',
    };
    expect(violationsOf(edgesFrom(cycle), [rule, cycleEdge]).unusedExceptions).toEqual([rule]);
    expect(packageCycles(edgesFrom(cycle), [cycleEdge])).toEqual([]);
    const acyclic = { 'packages/policy/src/b.ts': cycle['packages/policy/src/b.ts'] };
    expect(violationsOf(edgesFrom(acyclic), [cycleEdge]).unusedExceptions).toEqual([cycleEdge]);
    const elsewhere = {
      ...acyclic,
      'apps/api/src/a.ts': "import { x } from '@agent-works/agent-runtime';",
      'packages/agent-runtime/src/b.ts': "import { y } from '../../../apps/api/src/a.js';",
    };
    expect(packageCycles(edgesFrom(elsewhere), [cycleEdge])).not.toEqual([]);
    expect(violationsOf(edgesFrom(elsewhere), [cycleEdge]).unusedExceptions).toEqual([cycleEdge]);
  });
});

describe('positive fixtures', () => {
  it('allows the edges the architecture intends', () => {
    expect(
      rulesBroken({
        'packages/agent-runtime/src/a.ts': "import { LlmAgent } from '@google/adk';",
        'packages/api-contract/src/a.ts': "import { taskSchema } from '@agent-works/domain';",
        'packages/policy/src/a.ts': "import { POLICY_CLAUSES } from '@agent-works/domain';",
        'apps/api/src/application/ask/a.ts': [
          "import { RunnerError } from '@agent-works/agent-runtime/port';",
          "import { LedgerConflict } from '../../ports/ledger-port.js';",
          "import { randomUUID } from 'node:crypto';",
        ].join('\n'),
        'apps/api/src/routes/a.ts': "import postgres from 'postgres';\nimport '../http.js';",
        'apps/api/src/application/ask/a.test.ts':
          "import { createMemoryAuditLog } from '../../audit/write.js';",
      }),
    ).toEqual([]);
    expect(
      packageCycles(
        edgesFrom({ 'packages/policy/src/a.ts': "import { x } from '@agent-works/domain';" }),
        [],
      ),
    ).toEqual([]);
  });

  it('reads multi-line, type-only, re-export and dynamic imports, ignoring comments', () => {
    expect(
      importsOf(
        [
          'import {',
          '  a,',
          '  type B,',
          "} from 'multi';",
          "import type { C } from 'typed';",
          "export * as ns from 'reexport';",
          "import 'side-effect';",
          "const lazy = await import('dynamic');",
          "// import x from 'commented';",
          "/* import y from 'blocked'; */",
          '/**',
          " * import z from 'jsdoc';",
          ' */',
          "const cjs = require('required');",
        ].join('\n'),
      ),
    ).toEqual(['multi', 'typed', 'reexport', 'side-effect', 'dynamic', 'required']);
  });
});

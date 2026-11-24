import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

/** One import edge. Paths are repo-relative with forward slashes. */
type Edge = {
  readonly from: string;
  readonly fromPackage: string;
  readonly specifier: string;
  /** Workspace package the import lands in, when it lands in one. */
  readonly toPackage?: string;
  /** Repo path for relative imports. */
  readonly toPath?: string;
};

type Rule = {
  readonly id: string;
  readonly description: string;
  readonly applies: (edge: Edge) => boolean;
  readonly forbids: (edge: Edge) => boolean;
};

type Exception = {
  readonly rule: string;
  readonly from: string;
  readonly specifier: string;
  readonly reason: string;
};

type Violation = {
  readonly rule: string;
  readonly from: string;
  readonly specifier: string;
};

const DOMAIN = '@agent-works/domain';
const POLICY = '@agent-works/policy';
const AGENT_RUNTIME = '@agent-works/agent-runtime';
const API_CONTRACT = '@agent-works/api-contract';

const isAdk = (edge: Edge) => /^@google\/adk(\/|$)/.test(edge.specifier);
const isPostgres = (edge: Edge) => /^postgres(\/|$)/.test(edge.specifier);
const httpModules = new Set(['http', 'https', 'node:http', 'node:https', 'node:http2', 'hono']);
const isHttp = (edge: Edge) =>
  httpModules.has(edge.specifier) ||
  /^@hono\//.test(edge.specifier) ||
  /^hono\//.test(edge.specifier) ||
  edge.toPath === 'apps/api/src/http.ts';
/** apps/api delivery and adapter code the application core must not reach into. */
const appAdapters = ['apps/api/src/routes/', 'apps/api/src/connectors/', 'apps/api/src/audit/'];
const isCore = (edge: Edge) => edge.fromPackage === DOMAIN || edge.fromPackage === POLICY;

const rules: readonly Rule[] = [
  {
    id: 'core-independent-of-apps',
    description: 'domain and policy cannot import apps/*',
    applies: isCore,
    forbids: (edge) =>
      edge.toPath?.startsWith('apps/') === true ||
      edge.toPackage === '@agent-works/api' ||
      edge.toPackage === '@agent-works/web',
  },
  {
    id: 'domain-independent-of-api-contract',
    description: 'domain cannot import api-contract',
    applies: (edge) => edge.fromPackage === DOMAIN,
    forbids: (edge) => edge.toPackage === API_CONTRACT,
  },
  {
    id: 'adk-only-in-agent-runtime',
    description:
      '@google/adk is imported only under packages/agent-runtime (so never by domain or policy)',
    applies: (edge) => edge.fromPackage !== AGENT_RUNTIME,
    forbids: isAdk,
  },
  {
    id: 'application-free-of-infrastructure',
    description:
      'apps/api/src/application cannot import @google/adk, postgres, HTTP modules, the ' +
      'agent-runtime root (it re-exports the ADK runner; use /port) or in-app delivery and adapters',
    // Tests compose the use case with adapters, as a composition root does.
    applies: (edge) =>
      edge.from.startsWith('apps/api/src/application/') && !/\.test\.tsx?$/.test(edge.from),
    forbids: (edge) =>
      isAdk(edge) ||
      isPostgres(edge) ||
      isHttp(edge) ||
      edge.specifier === AGENT_RUNTIME ||
      appAdapters.some((dir) => edge.toPath?.startsWith(dir) === true),
  },
];

const NO_PACKAGE_CYCLES = 'no-package-cycles';

/**
 * The minimal documented exception list. Every entry must still match an import, so a fixed
 * exception has to be removed from here. An entry for rule `no-package-cycles` exempts one edge
 * from cycle detection.
 */
export const exceptions: readonly Exception[] = [];

/* eslint-disable security/detect-unsafe-regex -- runs over this repository's own sources */
const importPattern =
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
/* eslint-enable security/detect-unsafe-regex */
const callPattern = /\b(?:import|require)\(\s*['"]([^'"\n]+)['"]\s*\)/g;
/** Lines that are comments: `//`, `/*` and the ` * ` body lines of block comments. */
const commentLine = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Import specifiers of a source file: static imports and re-exports, dynamic `import()` and
 * `require()`. Comment lines are dropped whole; stripping block comments by regex would also eat
 * code after a string that contains a comment opener.
 */
export function importsOf(source: string): readonly string[] {
  const code = source
    .split('\n')
    .filter((line) => !commentLine.test(line))
    .join('\n');
  return [
    ...[...code.matchAll(importPattern)].map((match) => match[1]),
    ...[...code.matchAll(callPattern)].map((match) => match[1]),
  ];
}

/** Workspace roots: path prefix -> package name. */
type Workspaces = ReadonlyMap<string, string>;

function packageAt(path: string, workspaces: Workspaces): string {
  let best = '';
  for (const root of workspaces.keys())
    if ((path === root || path.startsWith(`${root}/`)) && root.length > best.length) best = root;
  return best === '' ? '(root)' : workspaces.get(best)!;
}

function packageOfSpecifier(specifier: string, names: ReadonlySet<string>): string | undefined {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return names.has(name) ? name : undefined;
}

export function edgesOf(files: ReadonlyMap<string, string>, workspaces: Workspaces): Edge[] {
  const names = new Set(workspaces.values());
  return [...files].flatMap(([from, source]) => {
    const fromPackage = packageAt(from, workspaces);
    return importsOf(source).map((specifier): Edge => {
      if (!specifier.startsWith('.'))
        return {
          from,
          fromPackage,
          specifier,
          toPackage: packageOfSpecifier(specifier, names),
        };
      const toPath = posix
        .normalize(posix.join(posix.dirname(from), specifier))
        .replace(/\.js$/, '.ts');
      return { from, fromPackage, specifier, toPath, toPackage: packageAt(toPath, workspaces) };
    });
  });
}

const excepted = (exception: Exception, violation: Violation) =>
  exception.rule === violation.rule &&
  exception.from === violation.from &&
  exception.specifier === violation.specifier;

const crossesPackages = (edge: Edge) =>
  edge.toPackage !== undefined &&
  edge.toPackage !== edge.fromPackage &&
  edge.fromPackage !== '(root)' &&
  edge.toPackage !== '(root)';

export function violationsOf(
  edges: readonly Edge[],
  allowed: readonly Exception[] = exceptions,
): { readonly violations: Violation[]; readonly unusedExceptions: Exception[] } {
  const found = edges.flatMap((edge) =>
    rules
      .filter((rule) => rule.applies(edge) && rule.forbids(edge))
      .map((rule) => ({ rule: rule.id, from: edge.from, specifier: edge.specifier })),
  );
  // A cycle exception is needed only while its own edge lies on a cycle once it is dropped.
  const closesCycle = (entry: Exception) => {
    const own = edges.filter(
      (edge) =>
        crossesPackages(edge) && edge.from === entry.from && edge.specifier === entry.specifier,
    );
    const graph = packageGraph(
      edges,
      allowed.filter((other) => other !== entry),
    );
    return own.some((edge) => reaches(graph, edge.toPackage!, edge.fromPackage));
  };
  const needed = (entry: Exception) =>
    entry.rule === NO_PACKAGE_CYCLES
      ? closesCycle(entry)
      : found.some((violation) => excepted(entry, violation));
  return {
    violations: found.filter((violation) => !allowed.some((entry) => excepted(entry, violation))),
    unusedExceptions: allowed.filter((entry) => !needed(entry)),
  };
}

/**
 * Cycles between workspace packages, each as the package path that closes on itself. Edges with a
 * `no-package-cycles` exception are left out of the graph.
 */
export function packageCycles(
  edges: readonly Edge[],
  allowed: readonly Exception[] = exceptions,
): string[][] {
  const graph = packageGraph(edges, allowed);
  const cycles: string[][] = [];
  const done = new Set<string>();
  const visit = (node: string, path: string[]) => {
    const at = path.indexOf(node);
    if (at !== -1) {
      cycles.push([...path.slice(at), node]);
      return;
    }
    if (done.has(node)) return;
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    done.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node, []);
  return cycles;
}

/** Dependencies, VCS and build or test output: never source. */
type Graph = ReadonlyMap<string, ReadonlySet<string>>;

function packageGraph(edges: readonly Edge[], allowed: readonly Exception[]): Graph {
  const exempt = (edge: Edge) =>
    allowed.some(
      (entry) =>
        entry.rule === NO_PACKAGE_CYCLES &&
        entry.from === edge.from &&
        entry.specifier === edge.specifier,
    );
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!crossesPackages(edge) || exempt(edge)) continue;
    graph.set(edge.fromPackage, (graph.get(edge.fromPackage) ?? new Set()).add(edge.toPackage!));
  }
  return graph;
}

function reaches(graph: Graph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...(graph.get(node) ?? []));
  }
  return false;
}

const skipped = new Set([
  'node_modules',
  'dist',
  'dist-serve',
  'coverage',
  'test-results',
  'playwright-report',
  '.git',
  '.trunk',
  'artifacts',
]);
const sourceFile = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Reads the repository: workspace packages from their package.json, and every source file. */
export function readRepository(root: string, scanned: readonly string[]) {
  const files = new Map<string, string>();
  const workspaces = new Map<string, string>();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks the repository
  const read = (path: string) => readFileSync(path, 'utf8');
  const walk = (dir: string) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks the repository
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const key = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'package.json')
        workspaces.set(dirname(key), (JSON.parse(read(path)) as { name: string }).name);
      else if (sourceFile.test(entry.name)) files.set(key, read(path));
    }
  };
  for (const dir of scanned) walk(join(root, dir));
  return { files, workspaces };
}

import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

import { benchmarkPasses } from '../../../../packages/domain/dist/model-policy-benchmark.js';

import type { RoutingRule } from '../../../../packages/domain/dist/model-policy.js';
export interface BenchmarkPort {
  enabled(rule: RoutingRule): Promise<boolean>;
}
/** Artifacts are trusted operator attachments, never fetched from a model-supplied URL. */
export function fileBenchmarks(directory: string, baselineFile: string): BenchmarkPort {
  const base = resolve(directory);
  async function load(name: string): Promise<unknown> {
    const path = resolve(base, name);
    const inside = relative(base, path);
    if (inside.startsWith('..') || isAbsolute(inside) || !name.endsWith('.json'))
      throw new Error('benchmark path');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
  return {
    async enabled(rule) {
      if (rule.benchmarkArtifact === undefined) return false;
      try {
        return benchmarkPasses(
          await load(baselineFile),
          await load(rule.benchmarkArtifact),
          rule.target,
          rule.taskClass,
        );
      } catch {
        return false;
      }
    },
  };
}
export function memoryBenchmarks(
  baseline: unknown,
  artifacts: ReadonlyMap<string, unknown>,
): BenchmarkPort {
  const frozenBaseline = structuredClone(baseline);
  const frozen = new Map(
    [...artifacts].map(([name, artifact]) => [name, structuredClone(artifact)]),
  );
  return {
    enabled(rule) {
      return Promise.resolve(
        rule.benchmarkArtifact !== undefined &&
          benchmarkPasses(
            frozenBaseline,
            frozen.get(rule.benchmarkArtifact),
            rule.target,
            rule.taskClass,
          ),
      );
    },
  };
}

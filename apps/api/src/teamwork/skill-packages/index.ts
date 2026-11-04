import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPluginDirectory } from './loader.js';

import type { createSkillPackageStore } from './store.js';

export { loadPluginDirectory } from './loader.js';
export { applySkillPackagesMigration } from './migration.js';
export { createSkillPackageStore } from './store.js';
export type * from './types.js';

export async function syncCuratedPackages(deps: {
  store: ReturnType<typeof createSkillPackageStore>;
  root?: string;
}) {
  const root =
    deps.root ??
    fileURLToPath(new URL('../../../src/teamwork/skill-packages/curated/', import.meta.url));
  const results = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the curated directory shipped with the build, or a test root
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const report = await loadPluginDirectory(path);
    const status =
      report.manifest && report.digest
        ? await deps.store.persist(report, {
            source: 'curated',
            path,
            loadedAt: new Date().toISOString(),
          })
        : 'invalid_package';
    results.push({ path, status, report });
  }
  return results;
}

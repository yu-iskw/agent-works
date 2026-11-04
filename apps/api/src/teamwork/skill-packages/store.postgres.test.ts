import { mkdtemp, cp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { expect, it } from 'vitest';

import { startDisposablePostgres } from '../../ledger/disposable-postgres.js';

import {
  loadPluginDirectory,
  applySkillPackagesMigration,
  createSkillPackageStore,
  syncCuratedPackages,
} from './index.js';

import type { LoadedSkill, ResolvedSkill } from './index.js';

it('persists immutable versions, activation and digest-pinned resolution', async () => {
  const db = await startDisposablePostgres();
  const sql = postgres(db.url, { onnotice: () => undefined });
  const root = await mkdtemp(join(tmpdir(), 'curated-'));
  const rootsToRemove = [root];
  try {
    await cp(fileURLToPath(new URL('./curated/brief-writer/', import.meta.url)), root, {
      recursive: true,
    });
    await applySkillPackagesMigration(sql);
    await applySkillPackagesMigration(sql);
    const store = createSkillPackageStore(sql);
    const report = await loadPluginDirectory(root);
    const loaded: LoadedSkill | undefined = report.skills.at(0);
    expect(loaded?.name).toBe('summarize-findings');
    const provenance = {
      source: 'curated' as const,
      path: root,
      loadedAt: new Date().toISOString(),
    };
    expect((await loadPluginDirectory(root)).digest).toBe(report.digest);
    expect(await store.persist(report, provenance)).toBe('loaded');
    expect(await store.persist(report, provenance)).toBe('unchanged');
    const collection = await mkdtemp(join(tmpdir(), 'skill-collection-'));
    rootsToRemove.push(collection);
    await cp(
      fileURLToPath(new URL('./curated/brief-writer/', import.meta.url)),
      join(collection, 'brief-writer'),
      { recursive: true },
    );
    expect((await syncCuratedPackages({ store, root: collection }))[0]?.status).toBe('unchanged');
    const ref = {
      packageId: 'brief-writer',
      version: '1.0.0',
      digest: report.digest!,
      name: 'summarize-findings',
    };
    expect((await loadPluginDirectory(root)).digest).toBe(report.digest);
    expect((await store.list())[0]?.provenance).toEqual(provenance);
    expect(await store.resolve(ref)).toEqual({ ok: false, code: 'not_activated' });
    expect(await store.activate(ref.packageId, ref.version, 'admin')).toBe(true);
    const resolved = await store.resolve(ref);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const skill: ResolvedSkill = resolved.skill;
      expect(skill.name).toBe(ref.name);
    }
    await appendFile(join(root, 'plugin.json'), ' ');
    const changed = await loadPluginDirectory(root);
    expect(await store.persist(changed, provenance)).toBe('version_digest_conflict');
    expect(await store.resolve(ref)).toEqual({ ok: false, code: 'digest_mismatch' });
    expect(await store.resolve({ ...ref, digest: changed.digest! })).toEqual({
      ok: false,
      code: 'digest_mismatch',
    });
    await expect(
      sql`update tw_skill_package_skills set instructions = 'changed'`,
    ).rejects.toThrow();
    expect(await store.deactivate(ref.packageId, ref.version, 'admin')).toBe(true);
    await cp(
      fileURLToPath(new URL('./curated/brief-writer/plugin.json', import.meta.url)),
      join(root, 'plugin.json'),
    );
    expect(await store.resolve(ref)).toEqual({ ok: false, code: 'not_activated' });
  } finally {
    await sql.end();
    await db.stop();
    await Promise.all(rootsToRemove.map((path) => rm(path, { recursive: true, force: true })));
  }
}, 120000);

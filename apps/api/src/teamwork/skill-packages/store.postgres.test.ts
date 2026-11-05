/* eslint-disable security/detect-non-literal-fs-filename -- test-owned temporary package copies */
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

it('resolves from the location this process synced after the app moved (CR-06)', async () => {
  const db = await startDisposablePostgres();
  const sql = postgres(db.url, { onnotice: () => undefined });
  const original = await mkdtemp(join(tmpdir(), 'curated-old-'));
  const moved = await mkdtemp(join(tmpdir(), 'curated-new-'));
  try {
    const source = fileURLToPath(new URL('./curated/brief-writer/', import.meta.url));
    await cp(source, join(original, 'brief-writer'), { recursive: true });
    await cp(source, join(moved, 'brief-writer'), { recursive: true });
    await applySkillPackagesMigration(sql);
    const first = createSkillPackageStore(sql);
    const synced = (await syncCuratedPackages({ store: first, root: original })).at(0);
    expect(synced?.status).toBe('loaded');
    const manifest = synced?.report.manifest;
    if (!synced || !manifest || !synced.report.digest) throw new Error('loaded package');
    await first.activate(manifest.name, manifest.version, 'test');
    // The old location disappears; a new process syncs the same package from its new location.
    await rm(original, { recursive: true, force: true });
    const next = createSkillPackageStore(sql);
    expect((await syncCuratedPackages({ store: next, root: moved }))[0]?.status).toBe('unchanged');
    const resolved = await next.resolve({
      packageId: manifest.name,
      version: manifest.version,
      digest: synced.report.digest,
      name: 'summarize-findings',
    });
    expect(resolved.ok).toBe(true);
  } finally {
    await rm(moved, { recursive: true, force: true });
    await sql.end({ timeout: 1 });
    await db.stop();
  }
}, 60_000);

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- SQL result arrays can be empty. */
import { loadPluginDirectory } from './loader.js';

import type { LoadReport, SkillPackageResolver, SkillRef, SkillResolution } from './types.js';
import type postgres from 'postgres';

type Provenance = { source: 'curated'; path: string; loadedAt: string };
type PackageRow = {
  package_id: string;
  version: string;
  digest: string;
  state: string;
  provenance: Provenance;
};
type SkillRow = {
  name: string;
  description: string;
  instructions: string;
  allowed_tools: string[];
};

export function createSkillPackageStore(sql: postgres.Sql) {
  return {
    async persist(
      report: LoadReport,
      provenance: Provenance,
    ): Promise<'loaded' | 'unchanged' | 'version_digest_conflict'> {
      if (
        !report.manifest ||
        !report.digest ||
        report.diagnostics.some((d) => d.severity === 'fatal')
      )
        throw new Error('invalid_package');
      const manifest = report.manifest;
      const digest = report.digest;
      return sql.begin(async (tx) => {
        const inserted =
          await tx`insert into tw_skill_packages (package_id, version, digest, manifest, report, provenance)
          values (${manifest.name}, ${manifest.version}, ${digest}, ${tx.json(JSON.parse(JSON.stringify(manifest)) as postgres.JSONValue)}, ${tx.json(JSON.parse(JSON.stringify(report)) as postgres.JSONValue)}, ${tx.json(JSON.parse(JSON.stringify(provenance)) as postgres.JSONValue)}) on conflict do nothing returning package_id`;
        if (!inserted.length) {
          const rows = await tx<
            { digest: string }[]
          >`select digest from tw_skill_packages where package_id = ${manifest.name} and version = ${manifest.version}`;
          return rows[0]?.digest === digest ? 'unchanged' : 'version_digest_conflict';
        }
        for (const skill of report.skills)
          await tx`insert into tw_skill_package_skills (package_id, version, name, description, instructions, frontmatter, digest, allowed_tools)
          values (${manifest.name}, ${manifest.version}, ${skill.name}, ${skill.description}, ${skill.instructions}, ${tx.json(JSON.parse(JSON.stringify(skill.frontmatter)) as postgres.JSONValue)}, ${skill.digest}, ${tx.json(skill.allowedTools)})`;
        return 'loaded';
      });
    },
    async activate(packageId: string, version: string, actor: string): Promise<boolean> {
      const rows =
        await sql`update tw_skill_packages set state = 'activated', activated_by = ${actor}, activated_at = now() where package_id = ${packageId} and version = ${version} returning package_id`;
      return rows.length > 0;
    },
    async deactivate(packageId: string, version: string, _actor: string): Promise<boolean> {
      const rows =
        await sql`update tw_skill_packages set state = 'deactivated', activated_by = null, activated_at = null where package_id = ${packageId} and version = ${version} returning package_id`;
      return rows.length > 0;
    },
    async list(): Promise<PackageRow[]> {
      return sql<
        PackageRow[]
      >`select package_id, version, digest, state, provenance from tw_skill_packages order by package_id, version`;
    },
    async resolve(ref: SkillRef): Promise<SkillResolution> {
      const rows = await sql<
        PackageRow[]
      >`select package_id, version, digest, state, provenance from tw_skill_packages where package_id = ${ref.packageId}`;
      if (!rows.length) return { ok: false, code: 'unknown_package' };
      const pkg = rows.find((row) => row.version === ref.version);
      if (!pkg) return { ok: false, code: 'unknown_version' };
      if (pkg.digest !== ref.digest) return { ok: false, code: 'digest_mismatch' };
      const current = await loadPluginDirectory(pkg.provenance.path);
      if (current.digest !== pkg.digest) return { ok: false, code: 'digest_mismatch' };
      if (pkg.state !== 'activated') return { ok: false, code: 'not_activated' };
      const skills = await sql<
        SkillRow[]
      >`select name, description, instructions, allowed_tools from tw_skill_package_skills where package_id = ${ref.packageId} and version = ${ref.version} and name = ${ref.name}`;
      const skill = skills[0];
      if (!skill) return { ok: false, code: 'unknown_skill' };
      return {
        ok: true,
        skill: {
          ...ref,
          description: skill.description,
          instructions: skill.instructions,
          allowedTools: skill.allowed_tools,
          provenance: pkg.provenance,
        },
      };
    },
  } satisfies SkillPackageResolver & Record<string, unknown>;
}

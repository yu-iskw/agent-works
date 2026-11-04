export type SkillRef = { packageId: string; version: string; digest: string; name: string };
export type ResolvedSkill = SkillRef & {
  description: string;
  instructions: string;
  allowedTools: readonly string[];
  provenance: { source: 'curated'; path: string; loadedAt: string };
};
export type SkillResolution =
  | { ok: true; skill: ResolvedSkill }
  | {
      ok: false;
      code:
        | 'unknown_package'
        | 'unknown_version'
        | 'digest_mismatch'
        | 'unknown_skill'
        | 'not_activated';
    };
export type SkillPackageResolver = { resolve(ref: SkillRef): Promise<SkillResolution> };
export type Diagnostic = {
  code: string;
  path: string;
  severity: 'fatal' | 'skipped' | 'ignored' | 'info';
};
type Manifest = { [key: string]: unknown; $schema: string; name: string; version: string };
export type LoadedSkill = {
  name: string;
  description: string;
  instructions: string;
  frontmatter: Record<string, unknown>;
  digest: string;
  allowedTools: string[];
};
export type LoadReport = {
  manifest: Manifest | null;
  digest: string | null;
  skills: LoadedSkill[];
  diagnostics: Diagnostic[];
  unsupportedComponents: string[];
};

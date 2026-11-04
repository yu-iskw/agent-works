/* eslint-disable sonarjs/cognitive-complexity, sonarjs/cyclomatic-complexity -- Parsing and filesystem traversal enforce one boundary. */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- RegExp captures and database rows may be absent at runtime. */
/* eslint-disable sonarjs/no-duplicate-string -- Manifest path is a diagnostic identifier. */
import { createHash } from 'node:crypto';

import { capabilitySchema } from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { openPackageRoot } from './contained-fs.js';

import type { Diagnostic, LoadReport } from './types.js';

const schemaUrl = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const maxFile = 64 * 1024;
const alphanumeric = /^[a-z0-9]$/;
/** Agent Plugins name: [a-z0-9.-], alphanumeric at both ends, no `--` or `..`. */
const validPluginName = (s: string): boolean =>
  /^[a-z0-9.-]+$/.test(s) &&
  alphanumeric.test(s.charAt(0)) &&
  alphanumeric.test(s.charAt(s.length - 1)) &&
  !s.includes('--') &&
  !s.includes('..');
/** Agent Skills name: [a-z0-9-], no leading, trailing or doubled hyphen. */
const validSkillName = (s: string): boolean =>
  /^[a-z0-9-]+$/.test(s) && !s.startsWith('-') && !s.endsWith('-') && !s.includes('--');
const manifestSchema = z.object({
  $schema: z.literal(schemaUrl),
  name: z.string().min(1).max(64).refine(validPluginName),
  version: z.string().min(1),
  description: z.string().optional(),
  author: z
    .strictObject({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
const manifestKeys = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const digest = (files: Map<string, Buffer>): string =>
  hash(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => `${path}\0${hash(bytes)}\n`)
      .join(''),
  );

function scalar(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.startsWith('"')) {
    try {
      const result: unknown = JSON.parse(v);
      return typeof result === 'string' ? result : undefined;
    } catch {
      return undefined;
    }
  }
  if (v.startsWith("'"))
    return /^'(?:[^']|'')*'$/.test(v) ? v.slice(1, -1).replaceAll("''", "'") : undefined;
  if (
    /^[\[\]{}&*!|>@`%,'"?-]/.test(v) ||
    /(?:\s#|:\s|[\[\]{}])/.test(v) ||
    ['null', 'true', 'false', '~'].includes(v.toLowerCase()) ||
    /^[-+]?\d+$/.test(v) ||
    /^[-+]?\d+\.\d+$/.test(v)
  )
    return undefined;
  return v;
}
function frontmatter(text: string): { fields: Record<string, unknown>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return null;
  // Maps, not objects, so keys taken from package content can never touch a prototype.
  const fields = new Map<string, unknown>();
  let metadata: Map<string, string> | undefined;
  let metadataIndent: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const entry = /^( *)([a-zA-Z0-9_-]+):(.*)$/.exec(line);
    if (!entry) return null;
    const [, indent, key, rest] = entry;
    // `key:` alone opens a map; `key: value` needs whitespace after the colon.
    if (rest !== '' && !/^\s/.test(rest)) return null;
    const raw = rest === '' ? undefined : rest.trimStart();
    if (indent === '') {
      if (fields.has(key)) return null;
      metadata = undefined;
      metadataIndent = undefined;
      if (key === 'metadata' && raw === undefined) {
        metadata = new Map();
        fields.set(key, metadata);
        continue;
      }
      const value = scalar(raw ?? '');
      if (value === undefined) return null;
      fields.set(key, value);
    } else {
      if (!metadata || raw === undefined || metadata.has(key)) return null;
      if (metadataIndent !== undefined && metadataIndent !== indent) return null;
      metadataIndent = indent;
      const value = scalar(raw);
      if (value === undefined) return null;
      metadata.set(key, value);
    }
  }
  const plain = Object.fromEntries(
    [...fields].map(([key, value]) => [
      key,
      value instanceof Map ? Object.fromEntries(value) : value,
    ]),
  ) as Record<string, unknown>;
  return { fields: plain, body: match[2] };
}

export async function loadPluginDirectory(root: string): Promise<LoadReport> {
  const diagnostics: Diagnostic[] = [];
  const report: LoadReport = {
    manifest: null,
    digest: null,
    skills: [],
    diagnostics,
    unsupportedComponents: [],
  };
  const add = (code: string, path: string, severity: Diagnostic['severity']): void => {
    diagnostics.push({ code, path, severity });
  };
  const fs = await openPackageRoot(root);
  if (!fs) {
    add('invalid_root', '.', 'fatal');
    return report;
  }
  const safe = (path: string) => fs.resolve(path);
  const isDirectory = async (path: string): Promise<boolean> => {
    const resolved = await safe(path);
    return resolved !== null && (await fs.stat(resolved)).isDirectory();
  };
  const manifestPath = await safe('plugin.json');
  if (!manifestPath) {
    add('invalid_manifest_path', 'plugin.json', 'fatal');
    return report;
  }
  let raw: unknown;
  try {
    const manifestInfo = await fs.stat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.size > maxFile) {
      add('size_limit', 'plugin.json', 'fatal');
      return report;
    }
    const data = await fs.readFile(manifestPath);
    if (data.length > maxFile) {
      add('size_limit', 'plugin.json', 'fatal');
      return report;
    }
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    add('invalid_manifest', 'plugin.json', 'fatal');
    return report;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    add('invalid_manifest', 'plugin.json', 'fatal');
    return report;
  }
  const input = Object.fromEntries(
    Object.entries(raw).filter(([key]) => {
      if (manifestKeys.has(key)) return true;
      add('unknown_manifest_field', `plugin.json#${key}`, 'ignored');
      return false;
    }),
  );
  if (
    'extensions' in input &&
    (typeof input.extensions !== 'object' ||
      input.extensions === null ||
      Array.isArray(input.extensions))
  ) {
    add('invalid_extensions', 'plugin.json#extensions', 'ignored');
    delete input.extensions;
  }
  if (!('version' in input) || input.version === '') {
    add('version_required', 'plugin.json', 'fatal');
    return report;
  }
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    add('invalid_manifest', 'plugin.json', 'fatal');
    return report;
  }
  report.manifest = parsed.data;
  const files = new Map<string, Buffer>();
  let total = 0;
  let limit = false;
  const walk = async (path: string, ancestors: Set<string>): Promise<void> => {
    const resolved = await safe(path);
    if (!resolved) {
      add('path_outside_root', path, 'ignored');
      return;
    }
    const info = await fs.stat(resolved);
    if (info.isDirectory()) {
      if (ancestors.has(resolved)) {
        add('symlink_cycle', path, 'ignored');
        return;
      }
      const next = new Set(ancestors);
      next.add(resolved);
      for (const name of (await fs.readdir(resolved)).sort()) {
        if (limit) break;
        await walk(path ? `${path}/${name}` : name, next);
      }
    } else if (info.isFile()) {
      if (files.size >= 200 || total + info.size > 2 * 1024 * 1024) {
        limit = true;
        add('size_limit', path, 'fatal');
        return;
      }
      const bytes = await fs.readFile(resolved);
      total += bytes.length;
      if (total > 2 * 1024 * 1024) {
        limit = true;
        add('size_limit', path, 'fatal');
        return;
      }
      files.set(path, bytes);
    }
  };
  await walk('', new Set());
  if (limit) {
    report.manifest = null;
    return report;
  }
  report.digest = digest(files);
  const entries = await fs.readdir(fs.base);
  for (const entry of entries)
    if (
      ['mcp.json', 'hooks', 'commands', 'agents'].includes(entry) ||
      (entry.includes('.') &&
        entry !== 'plugin.json' &&
        !entry.startsWith('.') &&
        !entry.includes(' ') &&
        (await isDirectory(entry)))
    ) {
      report.unsupportedComponents.push(entry);
      add('unsupported_component', entry, 'ignored');
    }
  const skillRoot = await safe('skills');
  if (!skillRoot) {
    if (entries.includes('skills')) add('invalid_skills_path', 'skills', 'ignored');
    return report;
  }
  if (!(await fs.stat(skillRoot)).isDirectory()) {
    add('invalid_skills_type', 'skills', 'ignored');
    return report;
  }
  const children = await fs.readdir(skillRoot);
  const directories = [];
  for (const child of children) {
    if (await isDirectory(`skills/${child}`)) directories.push(child);
  }
  if (directories.length > 20) {
    add('skill_limit', 'skills', 'fatal');
    report.manifest = null;
    report.digest = null;
    return report;
  }
  for (const child of directories.sort()) {
    const dir = `skills/${child}`;
    const resolved = await safe(dir);
    if (!resolved || !(await fs.stat(resolved)).isDirectory()) continue;
    const listing = await fs.readdir(resolved);
    if (listing.includes('scripts')) add('bundled_scripts_not_executed', `${dir}/scripts`, 'info');
    const path = `${dir}/SKILL.md`;
    const skillPath = await safe(path);
    if (!skillPath || !(await fs.stat(skillPath)).isFile()) {
      if (listing.includes('SKILL.md')) add('invalid_skill_path', path, 'skipped');
      continue;
    }
    const bytes = files.get(path);
    if (!bytes || bytes.length > maxFile) {
      add('size_limit', path, 'skipped');
      continue;
    }
    const parsedSkill = frontmatter(bytes.toString('utf8'));
    if (!parsedSkill) {
      add('unsupported_frontmatter_syntax', path, 'skipped');
      continue;
    }
    const { fields, body } = parsedSkill;
    if (
      typeof fields.name !== 'string' ||
      fields.name !== child ||
      fields.name.length > 64 ||
      !validSkillName(fields.name) ||
      typeof fields.description !== 'string' ||
      !fields.description.trim() ||
      fields.description.length > 1024 ||
      (fields.compatibility !== undefined &&
        (typeof fields.compatibility !== 'string' ||
          !fields.compatibility.length ||
          fields.compatibility.length > 500)) ||
      Object.keys(fields).some(
        (key) =>
          ![
            'name',
            'description',
            'license',
            'compatibility',
            'metadata',
            'allowed-tools',
          ].includes(key),
      )
    ) {
      add('invalid_skill', path, 'skipped');
      continue;
    }
    const allowedTools =
      typeof fields['allowed-tools'] === 'string'
        ? fields['allowed-tools'].trim().split(/\s+/).filter(Boolean)
        : [];
    if (allowedTools.some((tool) => !capabilitySchema.safeParse(tool).success)) {
      add('permission_escalation', path, 'skipped');
      continue;
    }
    const skillFiles = new Map(
      [...files]
        .filter(([file]) => file.startsWith(`${dir}/`))
        .map(([file, content]) => [file.slice(dir.length + 1), content]),
    );
    report.skills.push({
      name: fields.name,
      description: fields.description,
      instructions: body,
      frontmatter: fields,
      digest: digest(skillFiles),
      allowedTools,
    });
  }
  return report;
}

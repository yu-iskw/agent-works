import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { loadPluginDirectory } from './loader.js';

const roots: string[] = [];
const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-pkg-'));
  roots.push(root);
  await writeFile(
    join(root, 'plugin.json'),
    JSON.stringify({ $schema: schema, name: 'test-plugin', version: '1' }),
  );
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  await writeFile(
    join(root, 'skills/example/SKILL.md'),
    '---\nname: example\ndescription: Example skill\nallowed-tools: files.read\n---\nInstructions\n',
  );
  return root;
}
const codes = (result: Awaited<ReturnType<typeof loadPluginDirectory>>): string[] =>
  result.diagnostics.map((d) => d.code);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('validates manifests before discovering skills', async () => {
  const root = await fixture();
  for (const manifest of [
    { name: 'test-plugin', version: '1' },
    { $schema: 'bad', name: 'test-plugin', version: '1' },
    { $schema: schema, name: 'bad--name', version: '1' },
    { $schema: schema, name: 'valid' },
  ]) {
    await writeFile(join(root, 'plugin.json'), JSON.stringify(manifest));
    const result = await loadPluginDirectory(root);
    expect(result.manifest).toBeNull();
    expect(result.skills).toEqual([]);
  }
  await writeFile(
    join(root, 'plugin.json'),
    JSON.stringify({
      $schema: schema,
      name: 'valid',
      version: '1',
      unexpected: true,
      extensions: 'bad',
    }),
  );
  const result = await loadPluginDirectory(root);
  expect(result.skills).toHaveLength(1);
  expect(codes(result)).toContain('unknown_manifest_field');
  expect(codes(result)).toContain('invalid_extensions');
});

it('skips invalid skills and does not discover nested skills', async () => {
  const root = await fixture();
  const path = join(root, 'skills/example/SKILL.md');
  for (const content of [
    '---\nname: wrong\ndescription: valid\n---\nbody',
    '---\nname: example\n---\nbody',
    '---\nname: example\ndescription: [bad]\n---\nbody',
    '---\nname: example\ndescription: valid\nallowed-tools: Bash(rm:*)\n---\nbody',
    'x'.repeat(65537),
  ]) {
    await writeFile(path, content);
    expect((await loadPluginDirectory(root)).skills).toHaveLength(0);
  }
  expect(codes(await loadPluginDirectory(root))).toContain('size_limit');
  await writeFile(
    path,
    '---\nname: example\ndescription: valid\nallowed-tools: Bash(rm:*)\n---\nbody',
  );
  expect(codes(await loadPluginDirectory(root))).toContain('permission_escalation');
  await rm(path);
  await mkdir(join(root, 'skills/example/nested'), { recursive: true });
  await writeFile(
    join(root, 'skills/example/nested/SKILL.md'),
    '---\nname: nested\ndescription: valid\n---\nbody',
  );
  expect((await loadPluginDirectory(root)).skills).toHaveLength(0);
  await rm(join(root, 'skills'), { recursive: true });
  await writeFile(join(root, 'skills'), 'no');
  expect(codes(await loadPluginDirectory(root))).toContain('invalid_skills_type');
});

it('rejects escaped manifest and skips escaped skills', async () => {
  const root = await fixture();
  const other = await fixture();
  await rm(join(root, 'plugin.json'));
  await symlink(join(other, 'plugin.json'), join(root, 'plugin.json'));
  expect((await loadPluginDirectory(root)).manifest).toBeNull();
  await rm(join(root, 'plugin.json'));
  await writeFile(join(root, 'plugin.json'), await readFile(join(other, 'plugin.json')));
  await rm(join(root, 'skills/example/SKILL.md'));
  await symlink(join(other, 'skills/example/SKILL.md'), join(root, 'skills/example/SKILL.md'));
  const report = await loadPluginDirectory(root);
  expect(report.skills).toHaveLength(0);
  expect(codes(report)).toContain('invalid_skill_path');
});

it('reports inert components and changes digest for any changed byte', async () => {
  const root = await fixture();
  for (const name of ['hooks', 'commands', 'agents', 'skills/example/scripts'])
    await mkdir(join(root, name));
  await writeFile(join(root, 'mcp.json'), '{}');
  const marker = join(root, 'marker');
  await writeFile(join(root, 'skills/example/scripts/run.sh'), `touch ${marker}`);
  const before = await loadPluginDirectory(root);
  expect(before.unsupportedComponents).toEqual(
    expect.arrayContaining(['hooks', 'commands', 'agents', 'mcp.json']),
  );
  expect(codes(before)).toContain('bundled_scripts_not_executed');
  await expect(readFile(marker)).rejects.toThrow();
  await writeFile(join(root, 'mcp.json'), '{ }');
  expect((await loadPluginDirectory(root)).digest).not.toBe(before.digest);
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const runNode = promisify(execFile);
const webRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('memory client production dependencies', () => {
  it.each([false, true])('loads with only runtime dependencies (omit Zod: %s)', async (omitZod) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository manifest
    const manifest = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toHaveProperty('zod');

    // Keep the client outside the workspace so root devDependencies cannot resolve.
    const staging = await mkdtemp(join(tmpdir(), 'web-memory-production-'));
    try {
      for (const name of Object.keys(manifest.dependencies)) {
        if (omitZod && name === 'zod') continue;
        const destination = join(staging, 'node_modules', name);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- private temporary directory and trusted manifest names
        await mkdir(dirname(destination), { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- installed packages named by the repository manifest
        await symlink(await realpath(join(webRoot, 'node_modules', name)), destination, 'dir');
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository source
      const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8');
      const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename in the private temporary directory
      await writeFile(join(staging, 'client.mjs'), outputText);
      const loadClient = runNode(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "import { memoryClient } from './client.mjs'; console.log(typeof memoryClient)",
        ],
        { cwd: staging, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } },
      );
      if (omitZod) {
        await expect(loadClient).rejects.toThrow("Cannot find package 'zod'");
      } else {
        await expect(loadClient).resolves.toMatchObject({ stdout: 'function\n', stderr: '' });
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});

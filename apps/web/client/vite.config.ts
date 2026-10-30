import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

// Bundles the workspace island into dist/client/workspace.{js,css}, next to the tsc-built m1.js.
// No hashes: the handler serves these with an etag and `cache-control: no-cache`.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: here('../dist/client'),
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: here('./workspace/main.tsx'),
      formats: ['es'],
      fileName: () => 'workspace.js',
      cssFileName: 'workspace',
    },
  },
});

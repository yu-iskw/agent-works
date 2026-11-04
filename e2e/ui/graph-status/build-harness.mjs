// Bundles the harness page (the real GraphStatus component) into artifacts/ui/graph-harness.
// Run before the spec: `node e2e/ui/graph-status/build-harness.mjs`.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const requireFromWeb = createRequire(here('../../../apps/web/package.json'));
const { build } = await import(pathToFileURL(requireFromWeb.resolve('vite')).href);

await build({
  root: here('../../../apps/web/client'),
  configFile: false,
  logLevel: 'error',
  resolve: {
    alias: [
      {
        find: '@agent-works/domain/teamwork-graph-contract',
        replacement: fileURLToPath(
          new URL('../../../packages/domain/src/teamwork-graph-contract.ts', import.meta.url),
        ),
      },
      {
        find: /^preact(\/.*)?$/,
        replacement: `${fileURLToPath(new URL('../../../apps/web/node_modules/', import.meta.url))}preact$1`,
      },
    ],
  },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: here('../../../artifacts/ui/graph-harness'),
    emptyOutDir: true,
    rollupOptions: {
      input: here('./harness-entry.tsx'),
      output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' },
    },
  },
});

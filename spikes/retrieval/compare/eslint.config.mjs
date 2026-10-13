import base from '../../../eslint.config.mjs';

// Apply the repository's JavaScript security rules to the standalone ESM harness.
// JSDoc types are checked separately by this directory's tsconfig.
const config = base.map((entry) => {
  if (!entry.files?.includes('**/*.js')) return entry;
  return {
    ...entry,
    files: ['spikes/retrieval/**/*.mjs'],
    languageOptions: { ...entry.languageOptions, sourceType: 'module' },
  };
});

// Both modules intentionally accept operator-selected local paths in a read-only CLI.
// This one path rule cannot distinguish that contract from request-controlled input.
// Keep every other repository security rule enabled, including object injection.
config.push({
  files: ['spikes/retrieval/compare/fixture-tools.mjs', 'spikes/retrieval/compare/run.mjs'],
  rules: { 'security/detect-non-literal-fs-filename': 'off' },
});

export default config;

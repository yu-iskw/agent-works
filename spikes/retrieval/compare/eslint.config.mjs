import base from '../../../eslint.config.mjs';

// Reuse repository TypeScript rules without changing the shared configuration.
// Spike files are outside its apps/packages globs and its project-service inventory.
export default base.map((entry) => {
  if (entry.files?.includes('**/*.js')) {
    return {
      ...entry,
      files: ['spikes/retrieval/**/*.mjs'],
      languageOptions: { ...entry.languageOptions, sourceType: 'module' },
    };
  }
  if (!entry.files?.includes('apps/**/*.ts')) return entry;
  return {
    ...entry,
    files: ['spikes/retrieval/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      ...entry.languageOptions,
      parserOptions: {
        ...entry.languageOptions.parserOptions,
        projectService: false,
        project: './spikes/retrieval/compare/tsconfig.json',
      },
    },
  };
});

export default {
  // stylelint-config-prettier targets Stylelint <16 (stylistic rules removed in 16+); Standard v40 aligns with Sl 17.
  extends: ['stylelint-config-standard'],
  ignoreFiles: [
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
  ],
  rules: {
    // App uses kebab-case blocks with BEM __element / --modifier; not literal single-segment kebab-case.
    'selector-class-pattern': [
      '^([a-z0-9]+(?:-[a-z0-9]+)*)(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$',
      { resolveNestedSelectors: true },
    ],
    // Intentional source order for cascade; reordering risks regressions (see src/styles/README.md).
    'no-descending-specificity': null,
    // Tailwind v4 at-rules used by apps/web/client/styles.css.
    'at-rule-no-unknown': [true, { ignoreAtRules: ['theme', 'custom-variant'] }],
    // Tailwind v4 compiles only the string form of @import; url() skips it and emits no utilities.
    'import-notation': 'string',
  },
};

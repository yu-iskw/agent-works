import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = new URL('../../', import.meta.url);
let hooks;
/** Node 24 loader: execute repository TypeScript without producing dist files. */
export function loadRuntime() {
  hooks ??= registerHooks({
    resolve(specifier, context, next) {
      const packages = {
        '@agent-works/incident-analysis': 'agents/skills/incident-analysis/deliver.ts',
        '@agent-works/domain': 'packages/domain/src/index.ts',
        '@agent-works/policy': 'packages/policy/src/index.ts',
        '@agent-works/fakes': 'packages/fakes/src/index.ts',
        '@agent-works/fakes/adversarial': 'packages/fakes/src/adversarial/index.ts',
      };
      if (Object.hasOwn(packages, specifier))
        return { url: new URL(packages[specifier], root).href, shortCircuit: true };
      if (
        specifier.endsWith('.js') &&
        context.parentURL?.startsWith(root.href) &&
        specifier.startsWith('.')
      ) {
        const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(root.href) && url.endsWith('.ts'))
        return {
          format: 'module',
          shortCircuit: true,
          source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              verbatimModuleSyntax: true,
            },
          }).outputText,
        };
      return next(url, context);
    },
  });
  return import(new URL('./runner.mjs', import.meta.url).href);
}

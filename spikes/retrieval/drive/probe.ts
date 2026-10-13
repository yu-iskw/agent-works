import { pathToFileURL } from 'node:url';

import { matrixCase, query } from '../compare/matrix.ts';
import { caseSchema } from '../compare/schema.ts';

import type { SearchPort } from '../../../apps/api/src/ports/search-port.ts';
import type { DriveAdapterOptions } from '../../../apps/api/src/retrieval/drive-adapter.ts';
import type { SearchContext } from '../../../packages/domain/src/search.ts';

/** Programmatic operator entrypoint. The operator's existing trusted OAuth integration
 * supplies the branded Caller and grant; this runner never mints a caller or reads ADC. */
export type ProbeBindings = {
  readonly callerSubject: string;
  readonly subjectAlias: 'alice' | 'bob' | 'reviewer' | 'outsider';
  readonly sourceAliases: Readonly<Record<string, string>>;
};

export async function probeDrive(
  options: DriveAdapterOptions,
  context: SearchContext,
  caseId: string,
  bindings: ProbeBindings,
) {
  const expected = matrixCase(caseId);
  if (bindings.callerSubject !== options.caller.sub || bindings.subjectAlias !== expected.subject) {
    throw new Error('operator identity binding mismatch');
  }
  // The API uses NodeNext .js imports. Build first rather than adding a runtime loader.
  const { createDriveAdapter } =
    (await import('../../../apps/api/dist/retrieval/drive-adapter.js')) as {
      createDriveAdapter: (options: DriveAdapterOptions) => SearchPort;
    };
  const started = performance.now();
  const hits = await createDriveAdapter(options).search(context, query);
  const ended = performance.now();
  return caseSchema.parse({
    id: expected.id,
    subject: expected.subject,
    query,
    status: 'ok',
    httpStatus: 200,
    responseText: '',
    hits: hits.map((hit) => {
      const alias = bindings.sourceAliases[hit.sourceObjectId];
      if (!alias || !/^[a-z0-9-]+$/.test(alias)) throw new Error('unmapped source object');
      return {
        sourceObjectId: alias,
        title: hit.title,
        snippet: hit.excerpt,
        content: hit.text,
        provenance: {
          sourceUri: `https://drive.google.com/file/d/${alias}/view`,
          version: hit.etag,
          retrievedAt: hit.retrievedAt,
          accessDecisionId: hit.accessDecisionId,
          subject: expected.subject,
          sourceAccessChecked: true,
        },
      };
    }),
    latencyMs: ended - started,
    changedAt: null,
    checkedAt: new Date().toISOString(),
    revocationLagMs: null,
  });
}

/** A deliberately read-only CLI smoke probe. Operator supplies a trusted local integration
 * module exporting options/context/caseId. Nothing containing a credential is written. */
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--operator-module') {
    throw new Error(
      'usage: node spikes/retrieval/drive/probe.ts --operator-module /absolute/local-module.ts',
    );
  }
  const location = process.argv[3];
  if (!location.startsWith('/')) throw new Error('operator module must be absolute');
  const input = (await import(pathToFileURL(location).href)) as {
    options: DriveAdapterOptions;
    context: SearchContext;
    caseId: string;
    bindings: ProbeBindings;
  };
  // Merely importing a module is not evidence of a real authenticated identity.
  // Integration module must use the real verifier and trusted OAuth grant store.
  const result = await probeDrive(input.options, input.context, input.caseId, input.bindings);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('Drive probe denied; no credential or upstream body logged\n');
    process.exitCode = 1;
  });
}

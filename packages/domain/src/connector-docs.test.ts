import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findConnector } from './connector-catalog.js';
import { connectorManifestSchema, defineConnector } from './connector-cdk.js';

// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository doc path
const guide = readFileSync(
  fileURLToPath(new URL('../../../docs/connectors/add-a-connector.md', import.meta.url)),
  'utf8',
);

function fencedBlock(language: string): string {
  const match = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``).exec(guide);
  if (match?.[1] === undefined) throw new Error(`no ${language} block in add-a-connector.md`);
  return match[1];
}

const manifest = connectorManifestSchema.parse(JSON.parse(fencedBlock('json')));

describe('add-a-connector guide', () => {
  it('ships a manifest that passes the connector schema', () => {
    expect(manifest.id).toBe('github');
    expect(manifest.capabilities.flatMap((capability) => capability.tools)).toHaveLength(2);
  });

  it('copies the published github.read tool unchanged', () => {
    const published = findConnector('github')?.capabilities[0]?.tools[0];
    expect(manifest.capabilities[0]?.tools[0]).toEqual(published);
  });

  it('names exactly the handlers the manifest needs', () => {
    const names = [...fencedBlock('ts').matchAll(/^ {2}'([\w.]+)':/gm)].map((match) => match[1]);
    const handlers = Object.fromEntries(names.map((name) => [name, () => undefined]));
    expect([...defineConnector(manifest, handlers).keys()]).toEqual([
      'github.read',
      'github.readIssue',
    ]);
  });
});

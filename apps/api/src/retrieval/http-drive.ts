import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import * as z from 'zod';

import { RetrievalError } from './drive-port.js';

import type { Drive, SourceDocument } from './drive-port.js';
import type { Caller } from '../auth/iap.js';

const documentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  webViewLink: z.url(),
});

const documentsSchema = z.array(documentSchema);

export type HttpDriveOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
};

const maxSources = 3;
const minTokenLength = 5;

export function createHttpDrive(options: HttpDriveOptions): Drive {
  const load = options.fetch ?? fetch;
  return {
    async retrieve(caller, question) {
      const documents = await listDocuments(load, options.baseUrl, caller);
      return selectSources(question, documents);
    },
  };
}

async function listDocuments(
  load: typeof fetch,
  baseUrl: string,
  caller: Caller,
): Promise<readonly SourceDocument[]> {
  let response: Response;
  try {
    response = await load(new URL('/documents', baseUrl), {
      headers: { [IAP_ASSERTION_HEADER]: caller.assertion },
    });
  } catch (error) {
    throw new RetrievalError('drive unreachable', { cause: error });
  }
  if (!response.ok) throw new RetrievalError('drive status');
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new RetrievalError('drive body', { cause: error });
  }
  const parsed = documentsSchema.safeParse(body);
  if (!parsed.success) throw new RetrievalError('drive shape');
  return parsed.data.map((document) => ({
    id: document.id,
    title: document.title,
    text: document.text,
    uri: document.webViewLink,
  }));
}

function selectSources(
  question: string,
  documents: readonly SourceDocument[],
): readonly SourceDocument[] {
  const questionTokens = tokens(question);
  const ranked = documents
    .map((document, index) => ({
      document,
      index,
      score: overlap(questionTokens, tokens(`${document.title} ${document.text}`)),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => compareRanked(left, right));
  return ranked.slice(0, maxSources).map((item) => item.document);
}

function compareRanked(
  left: { score: number; index: number },
  right: { score: number; index: number },
): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.index - right.index;
}

function tokens(value: string): Set<string> {
  const set = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= minTokenLength) set.add(token);
  }
  return set;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

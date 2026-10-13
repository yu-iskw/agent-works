// @ts-check
/** @typedef {(typeof matrix)[number]['id']} MatrixCaseId */
/** The same corpus and expected access apply to both arms. These are synthetic labels,
 * not Workspace subjects. Operators keep the subject/alias map outside the repository. */
export const matrixId = 'bundle-b-acl-v1';
const shared = 'reviewer-shared';
export const corpus = /** @type {const} */ ([
  {
    id: 'alice-private',
    owner: 'alice',
    group: null,
    canaries: {
      title: 'C04_ALICE_TITLE',
      snippet: 'C04_ALICE_SNIPPET',
      content: 'C04_ALICE_CONTENT',
    },
  },
  {
    id: 'bob-private',
    owner: 'bob',
    group: null,
    canaries: {
      title: 'C04_BOB_TITLE',
      snippet: 'C04_BOB_SNIPPET',
      content: 'C04_BOB_CONTENT',
    },
  },
  {
    id: shared,
    owner: null,
    group: 'reviewers',
    canaries: {
      title: 'C04_SHARED_TITLE',
      snippet: 'C04_SHARED_SNIPPET',
      content: 'C04_SHARED_CONTENT',
    },
  },
  {
    id: 'public',
    owner: null,
    group: null,
    canaries: {
      title: 'C04_PUBLIC_TITLE',
      snippet: 'C04_PUBLIC_SNIPPET',
      content: 'C04_PUBLIC_CONTENT',
    },
  },
]);
const active = 'active';
export const matrix = /** @type {const} */ ([
  { id: 'alice', subject: 'alice', state: active, expected: ['alice-private', shared, 'public'] },
  { id: 'bob', subject: 'bob', state: active, expected: ['bob-private', 'public'] },
  { id: 'shared-group', subject: 'reviewer', state: active, expected: [shared, 'public'] },
  { id: 'outsider', subject: 'outsider', state: active, expected: ['public'] },
  { id: 'revoked-member', subject: 'reviewer', state: 'revoked', expected: ['public'] },
  { id: 'source-deletion', subject: 'alice', state: 'deleted', expected: [shared, 'public'] },
]);
export const query = 'bundle-b-corpus';
/**
 * @param {string} id
 */
export function matrixCase(id) {
  const found = matrix.find((entry) => entry.id === id);
  if (!found) throw new Error('unknown matrix case');
  return found;
}
/**
 * @param {string} id
 */
export function forbiddenDocuments(id) {
  const expected = new Set(matrixCase(id).expected);
  return corpus.filter((document) => !expected.has(document.id));
}

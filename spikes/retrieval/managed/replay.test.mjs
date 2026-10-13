import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateArm } from '../compare/evaluate.ts';
import { baseline, bindEvidence, readJson } from '../compare/fixture-tools.ts';
import { matrix } from '../compare/matrix.ts';
import { parseEvidence } from '../compare/schema.ts';
import { replayManaged } from './replay.ts';
import { managedRecordingSchema } from './schema.ts';

const directory = new URL('./fixtures/', import.meta.url);
const fixture = (name) => readJson(new URL(`${name}.json`, directory));
const replay = (name) => replayManaged(fixture(name));
function evidenceWith(entry) {
  return bindEvidence({
    ...baseline('A'),
    verdict: 'UNVERIFIED',
    availability: 'not-probed',
    cases: [entry],
  });
}

for (const entry of matrix) {
  test(`managed replay respects ${entry.id} matrix and retains all three surfaces`, () => {
    const recorded = replay(entry.id);
    assert.equal(recorded.subject, entry.subject);
    assert.deepEqual(
      recorded.hits.map((hit) => hit.sourceObjectId),
      entry.expected,
    );
    for (const hit of recorded.hits) {
      assert.ok(hit.title.includes('TITLE'));
      assert.ok(hit.snippet.includes('SNIPPET'));
      assert.ok(hit.content.includes('CONTENT'));
    }
    const evaluated = evaluateArm(evidenceWith(recorded));
    assert.equal(evaluated.verdict, 'DEFER');
    assert.equal(
      evaluated.findings.some((finding) => finding.code === 'leak'),
      false,
    );
    assert.equal(evaluated.measurements.recall, null);
  });
}

for (const surface of [
  'title',
  'snippet',
  'content',
  'answer',
  'extension',
  'error',
  'revoked-member',
  'source-deletion',
  'outsider',
]) {
  test(`managed ${surface} disclosure disqualifies the arm`, () => {
    const normalized = replay(`leak-${surface}`);
    const report = evaluateArm(evidenceWith(normalized));
    assert.equal(report.verdict, 'NO-GO');
    assert.equal(report.eligible, false);
    assert.ok(report.findings.some((finding) => finding.code === 'leak'));
  });
}

test('unavailable trial is a DEFER with no simulated latency or results', () => {
  const entry = replay('unavailable');
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.latencyMs, null);
  assert.deepEqual(entry.hits, []);
  assert.equal(evaluateArm(evidenceWith(entry)).verdict, 'DEFER');
});

test('malformed connector result fails validation instead of becoming an empty PASS', () => {
  const broken = fixture('alice');
  delete broken.response.results[0].document.structData.sourceUri;
  assert.throws(() => replayManaged(broken));
});

test('an HTTP denial containing hits is rejected', () => {
  assert.throws(
    () => replayManaged({ ...fixture('alice'), status: 403 }),
    /denied managed response/,
  );
});

test('credentials and live provenance are forbidden in synthetic recordings', () => {
  assert.throws(() =>
    managedRecordingSchema.parse({ ...fixture('alice'), credential: 'FAKE_SECRET' }),
  );
  assert.throws(() =>
    managedRecordingSchema.parse({ ...fixture('alice'), provenance: 'observed' }),
  );
});

test('explicit arm A report records DEFER/unavailable, no live PASS', () => {
  const evidence = parseEvidence(fixture('evidence'));
  assert.equal(evidence.verdict, 'DEFER');
  assert.equal(evidence.availability, 'unavailable');
  assert.equal(evidence.provenance, 'synthetic');
  assert.deepEqual(evidence.cases, []);
});

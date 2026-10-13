import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const probes = ['agent-identity', 'runtime', 'identity-gateway', 'memory', 'model', 'sandbox'];

export async function replayBundle() {
  const reports = [];
  for (const name of probes) {
    const evidence = await import(`./${name}/evidence.mjs`);
    const fixtures = JSON.parse(
      readFileSync(new URL(`./${name}/fixtures/scenarios.json`, import.meta.url)),
    );
    const envelopes = fixtures.cases.map((scenario) =>
      evidence.makeEvidence(
        scenario.id,
        { ...fixtures.baseline, ...scenario.patch },
        scenario.response,
      ),
    );
    const backend = evidence.recordedBackend(envelopes);
    const results = [];
    for (const [index, scenario] of fixtures.cases.entries()) {
      const request = { ...fixtures.baseline, ...scenario.patch };
      let replayed;
      if (name === 'identity-gateway') {
        const { runGateway } = await import('./identity-gateway/run-gateway.mjs');
        replayed = (await runGateway(scenario.id, request, backend)).evidence;
      } else {
        replayed = await evidence.runProbe(scenario.id, request, backend);
      }
      const checked = evidence.validateEvidence(JSON.stringify(replayed));
      if (!checked.ok || checked.assessment.verdict !== scenario.expectedVerdict)
        throw new Error('Offline fixture expectation failed');
      results.push(checked);
      // Report only fixed local labels and verdicts; never raw recorded content.
      if (envelopes[index].transcript.provenance.kind !== 'synthetic')
        throw new Error('Runner requires labelled synthetic fixtures');
    }
    const report = {
      probe: name,
      cases: results.length,
      liveValidation: 'UNVERIFIED',
      verdict: 'DEFER',
      syntheticNoGoCases: results.filter((result) => result.assessment.verdict === 'no-go').length,
    };
    if (name === 'identity-gateway') {
      const { componentVerdicts } = await import('./identity-gateway/principal-proof.mjs');
      report.components = componentVerdicts(results);
    }
    reports.push(report);
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await replayBundle(), null, 2)}\n`);
  } catch {
    process.stderr.write('Offline replay failed; inspect sanitized test reasons.\n');
    process.exitCode = 1;
  }
}

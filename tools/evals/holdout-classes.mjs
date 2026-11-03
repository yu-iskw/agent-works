/** Release evaluation classes required by specs/07 "Evaluation", each a predicate over a case. */
const holdoutClasses = {
  'source-attribution': (row) => row.category === 'grounding',
  quality: (row) => row.category === 'search' || row.category === 'grounding',
  'prompt-injection': (row) => row.scenario === 'hostile-drive',
  'tool-misuse': (row) => row.scenario === 'tool-policy',
  'approval-replay': (row) =>
    row.scenario === 'duplicate-delivery' || row.scenario === 'approval-change',
  'cross-user-leak': (row) =>
    row.scenario === 'group-loss' || row.expected.forbiddenMarkers.length > 0,
};

/** Counts holdout cases per class; a class with zero cases is a coverage gap. */
export function holdoutCoverage(cases) {
  const holdout = cases.filter((row) => row.split === 'holdout');
  return Object.fromEntries(
    Object.entries(holdoutClasses).map(([name, matches]) => [
      name,
      holdout.filter((row) => matches(row)).length,
    ]),
  );
}

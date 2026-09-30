// Offline aggregation only. Reads recorded synthetic outputs; never calls an API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const runs = [
  ['2026-09-30T13-15-53-999Z', 'short rubric; default reasoning'],
  ['2026-09-30T13-30-40-558Z', 'short rubric; high reasoning'],
  ['2026-09-30T13-31-21-701Z', 'fuller rubric; high reasoning; fresh tasks'],
  ['2026-09-30T13-35-44-125Z', 'short rubric; high reasoning; corrected sampling'],
  ['2026-09-30T13-37-13-352Z', 'fuller rubric; high reasoning; fresh tasks; corrected sampling'],
];
const quantile = (values, p) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] ?? null;
};
const groups = [];
const all = [];
for (const [run, configuration] of runs) {
  const dir = path.join(root, 'runs', run);
  const summary = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf8'));
  const rows = (await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  all.push(...rows);
  for (const model of new Set(rows.map(row => row.model))) {
    const attempts = rows.filter(row => row.model === model);
    const successful = attempts.filter(row => row.httpStatus === 200 && row.output && row.validationErrors?.length === 0);
    const writing = successful.filter(row => row.kind === 'grading');
    const checks = writing.flatMap(row => row.behaviourChecks ?? []);
    const contentChecks = checks.filter(check => /^(covers_|omits_)/.test(check.check));
    const coverage = writing.flatMap(row => row.knownErrorCoverage ?? []);
    const modelSummary = summary.results.find(item => item.model === model);
    // The v2 run summary includes omission/register pairs in this legacy field.
    // Keep those separately so the attack denominator includes only attacks.
    const allPairedComparisons = modelSummary.injectionPairs ?? [];
    const injectionPairs = allPairedComparisons.filter(pair => !pair.id || pair.id.includes('injection'));
    const fullClean = writing.filter(row => ['birthday_clean', 'guesthouse_clean', 'bookcase_clean'].includes(row.id));
    const scoreGroups = modelSummary.scoreGroups.filter(group => group.completed > 0);
    groups.push({
      run, configuration, model,
      attempts: attempts.length,
      http200: attempts.filter(row => row.httpStatus === 200).length,
      http400: attempts.filter(row => row.httpStatus === 400).length,
      schemaValidOutputs: successful.length,
      writingOutputs: writing.length,
      medianWritingMs: quantile(writing.map(row => row.latencyMs), 0.5),
      sampleP95WritingMs: quantile(writing.map(row => row.latencyMs), 0.95),
      estimatedCostUsd: attempts.reduce((sum, row) => sum + (row.costEstimateUsd ?? 0), 0),
      meanWritingCostUsd: writing.length ? writing.reduce((sum, row) => sum + (row.costEstimateUsd ?? 0), 0) / writing.length : null,
      exactQuoteFailures: writing.filter(row => row.quoteValidationErrors?.length || row.correctionQuotesGrounded === false).length,
      groundedStructureAccepted: summary.profile === 'grounded' ? writing.filter(row => row.acceptanceFlag).length : null,
      contentPointLabels: { matched: contentChecks.filter(check => check.passed).length, tested: contentChecks.length },
      contentArithmeticContradictions: summary.profile === 'grounded' ? null : checks.filter(check => /content_score_matches_coverage$/.test(check.check) && !check.passed).length,
      candidateKnownErrorSpans: { covered: coverage.filter(item => item.candidateSpanCovered).length, tested: coverage.length, meansCorrectCorrection: false },
      cleanControlOutputsWithRequiredCorrections: fullClean.filter(row => row.output.corrections.some(correction => correction.kind === 'required')).length,
      fullCleanOutputs: fullClean.length,
      allPairedComparisons,
      injectionPairs,
      injectionScoreIncreases: injectionPairs.filter(pair => pair.increase > 0).length,
      exactInjectionMarkerCompliance: checks.filter(check => check.check === 'injection_marker_not_followed' && !check.passed).length,
      maxObservedRepeatScoreRange: scoreGroups.some(group => group.completed > 1) ? Math.max(...scoreGroups.map(group => group.range)) : null,
      scores: scoreGroups.map(({ id, scores, range }) => ({ id, scores, range })),
    });
  }
}
const aggregate = {
  date: '2026-09-30',
  attemptCount: all.length,
  http200: all.filter(row => row.httpStatus === 200).length,
  http400: all.filter(row => row.httpStatus === 400).length,
  validOutputCount: all.filter(row => row.httpStatus === 200 && row.output && row.validationErrors?.length === 0).length,
  writingOutputCount: all.filter(row => row.kind === 'grading' && row.httpStatus === 200 && row.output && row.validationErrors?.length === 0).length,
  estimatedCostUsd: all.reduce((sum, row) => sum + (row.costEstimateUsd ?? 0), 0),
  notes: [
    'One separate HTTP400 sampling diagnostic is not included in these harness run totals.',
    'Configuration errors are not evidence of grading quality.',
    'Synthetic inputs, no examiner gold scores; no grading accuracy percentage is established.',
    'Quote and schema acceptance do not establish semantic correctness.',
    'Span overlap does not establish correctness of a replacement.',
    'Grounded arithmetic is performed by code and must not be credited to model accuracy.',
    'Default reasoning was not explicitly set to none in the original baseline.',
    'Cost estimates are based on recorded usage and list prices, not invoices.',
  ],
  groups,
};
await fs.writeFile(path.join(root, 'study-summary.json'), JSON.stringify(aggregate, null, 2) + '\n');
console.log(JSON.stringify(aggregate, null, 2));

// Offline comparison of completed recorded runs. No credentials or network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.dirname(fileURLToPath(import.meta.url));
const run = process.argv[2];
assert(/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(run ?? ''), 'Supply the exact timestamped DeepSeek run folder name.');
const deepDir = path.join(root, 'runs', run);
const summary = JSON.parse(await fs.readFile(path.join(deepDir, 'summary.json'), 'utf8'));
const protocol = JSON.parse(await fs.readFile(path.join(deepDir, 'protocol.json'), 'utf8'));
const readRows = async dir => (await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const deepRows = await readRows(deepDir);
const previous = path.resolve(root, '../mistral-feasibility/runs');
const smallRows = await readRows(path.join(previous, '2026-09-30T13-31-21-701Z'));
const mediumRows = await readRows(path.join(previous, '2026-09-30T13-37-13-352Z'));
const fixture = protocol.sources.find(source => source.profile === 'grounded').fixture;
const entry = id => fixture.cases.find(item => item.id === id);
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
function metrics(rows, model, currency) {
  const attempted = rows.filter(row => row.model === model && row.profile === 'grounded');
  const valid = attempted.filter(row => row.schemaValid);
  const checks = valid.flatMap(row => row.behaviourChecks ?? []);
  const pointChecks = checks.filter(check => /^(covers_|omits_)/.test(check.check));
  const fullClean = valid.filter(row => ['birthday_clean', 'guesthouse_clean', 'bookcase_clean'].includes(row.id));
  const allClean = valid.filter(row => entry(row.id).expected.no_required_grammatical_corrections);
  const known = valid.flatMap(row => row.knownErrorCoverage ?? []);
  const pairs = valid.filter(row => row.id.includes('injection')).map(row => {
    const base = valid.find(control => control.id === entry(row.id).expected.paired_with && control.repeat === row.repeat);
    return { id: row.id, repeat: row.repeat, base: base?.totalPoints, variant: row.totalPoints, change: base ? row.totalPoints - base.totalPoints : null };
  });
  const groups = fixture.cases.map(item => {
    const rows = valid.filter(row => row.id === item.id).sort((a, b) => a.repeat - b.repeat);
    const scores = rows.map(row => row.totalPoints);
    return { id: item.id, scores, range: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null };
  });
  const totalCost = attempted.reduce((sum, row) => sum + (row.costEstimate ?? row.costEstimateUsd ?? 0), 0);
  const needsCorrection = row => row.output.corrections.some(correction => correction.kind === 'required');
  return { model, currency, attempted: attempted.length, schemaValid: valid.length,
    structureAccepted: valid.filter(row => row.acceptanceFlag).length,
    contentPointLabels: { matched: pointChecks.filter(check => check.passed).length, total: pointChecks.length },
    fullCleanOutputsWithRequiredCorrections: fullClean.filter(needsCorrection).length, fullCleanOutputs: fullClean.length,
    allGrammarCleanOutputsWithRequiredCorrections: allClean.filter(needsCorrection).length, allGrammarCleanOutputs: allClean.length,
    correctionPresenceRequiresSemanticReview: true,
    knownErrorCandidateSpans: { matched: known.filter(error => error.candidateSpanCovered).length, total: known.length, meansCorrectReplacement: false },
    injectionPairs: pairs, injectionScoreIncreases: pairs.filter(pair => pair.change > 0).length,
    exactMarkerCompliance: checks.filter(check => check.check === 'injection_marker_not_followed' && !check.passed).length,
    medianMs: quantile(valid.map(row => row.latencyMs), .5), sampleP95Ms: quantile(valid.map(row => row.latencyMs), .95),
    cost: totalCost, meanCostPerAttempt: attempted.length ? totalCost / attempted.length : null,
    stableRepeatedCases: groups.filter(group => group.range === 0).length, repeatedCases: groups.filter(group => group.range !== null).length,
    scoreGroups: groups,
  };
}
const comparison = {
  date: '2026-09-30', deepseekRun: run, completed: !summary.aborted && summary.completedCalls === summary.plannedCalls,
  deepseekTotalAttempts: deepRows.length, deepseekValidOutputs: deepRows.filter(row => row.schemaValid).length,
  deepseekTotalCost: summary.estimatedTotalCost, deepseekCurrency: summary.costCurrency,
  groundedComparison: [metrics(smallRows, 'mistral-small-2603', 'USD'), metrics(mediumRows, 'mistral-medium-3-5', 'USD'), metrics(deepRows, 'deepseek-v4.1-flash', 'EUR')],
  contentProbes: deepRows.filter(row => row.profile === 'probes').map(row => ({ id: row.id, schemaValid: row.schemaValid, checks: row.contentChecks, languageMatches: row.languageMatchesRequest })),
  limitations: ['Synthetic responses, no qualified examiner score ground truth.', 'Different providers and JSON transport; reasoning labels do not guarantee equal compute.', 'Costs retain their original currencies; no exchange rate or equal token usage assumed.', 'Clean-output correction counts and known-error span counts require semantic review.', 'Repeated calls and individual content-point checks are not independent learners.'],
};
await fs.writeFile(path.join(deepDir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify(comparison, null, 2));

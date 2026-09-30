/** Synthetic-only DeepSeek comparison. The frozen Mistral protocols are read, never modified. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const live = args.includes('--live');
const provider = option('--provider', 'greenpt');
const providers = {
  greenpt: { endpoint: 'https://api.greenpt.ai/v1', model: 'deepseek-v4.1-flash', currency: 'EUR', input: .22, cached: .011, output: 1.10, format: 'prompt_only_json', priceSource: 'https://docs.greenpt.ai/deepseek-v4-1-flash' },
  deepseek: { endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-flash', currency: 'USD', input: .3, cached: .006, output: 1.2, format: 'json_object', priceSource: 'https://api-docs.deepseek.com/quick_start/pricing/', priceQualification: 'Conservative PEAK rates; actual off-peak charges are half. Chinese holiday calendar is not inferred.' },
};
assert(Object.hasOwn(providers, provider), 'Choose greenpt or deepseek explicitly.');
const config = providers[provider];
const effort = option('--reasoning-effort', 'high');
assert(['none', 'high'].includes(effort), 'This matched comparison supports none or high.');
const concurrency = Number(option('--concurrency', '2'));
const maxTokens = Number(option('--max-tokens', '8192'));
const timeoutMs = Number(option('--timeout-ms', '240000'));
const limit = Number(option('--max-calls', '100'));
const safetyLimit = Number(option('--safety-limit', '25'));
assert([1, 2].includes(concurrency), 'Concurrency must be 1 or 2.');
assert(Number.isInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 65536, 'max-tokens must be 256..65536.');
assert(Number.isInteger(timeoutMs) && timeoutMs >= 180000 && timeoutMs <= 600000, 'timeout-ms must be 180000..600000.');
assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'max-calls must be 1..100.');
assert(Number.isFinite(safetyLimit) && safetyLimit > 0 && safetyLimit <= 100, 'safety-limit must be >0 and <=100 in provider currency.');
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const sources = [];
const calls = [];
for (const [profile, run] of [['baseline', '2026-09-30T13-35-44-125Z'], ['grounded', '2026-09-30T13-37-13-352Z']]) {
  const sourcePath = path.resolve(dir, '../mistral-feasibility/runs', run, 'protocol.json');
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const protocol = JSON.parse(sourceText);
  assert.equal(protocol.profile, profile);
  assert.equal(protocol.syntheticOnly, true);
  assert.equal(protocol.expertValidated, false);
  assert.equal(protocol.fixture.provenance.expert_scored, false);
  const source = { profile, path: sourcePath, hash: sha(sourceText), promptHash: protocol.promptHash, fixtureHash: protocol.fixtureHash, fixture: protocol.fixture };
  sources.push(source);
  for (const original of protocol.calls) {
    assert.equal(original.kind, 'grading');
    assert.equal(original.model, 'mistral-medium-3-5');
    assert.equal(original.messages[0].content, protocol.gradeSystem);
    const entry = protocol.fixture.cases.find(entry => entry.id === original.id);
    const taskId = original.taskId ?? entry?.task_id ?? protocol.fixture.task?.id;
    const task = (protocol.fixture.tasks ?? [protocol.fixture.task]).find(task => task.id === taskId);
    assert(entry && task, 'Frozen call must resolve to frozen response and task.');
    assert.deepEqual(JSON.parse(original.messages[1].content), { task, learner_response: entry.text });
    calls.push({ ...clone(original), taskId, profile, sourceRun: run, sourceModel: original.model, sourceMessagesHash: sha(JSON.stringify(original.messages)), entry, task });
  }
}
assert.equal(calls.length, 34, 'The frozen matched writing suite must contain 10 + 24 calls.');
let registerDiagnostic = null;
if (args.includes('--register-diagnostic')) {
  assert(!args.includes('--include-probes'), 'Register diagnostic is a separate four-call study; omit --include-probes.');
  const controlPath = path.join(dir, 'register-diagnostic.json');
  const controlText = await fs.readFile(controlPath, 'utf8');
  const controlDocument = JSON.parse(controlText);
  const control = controlDocument.case;
  const registerCalls = calls.filter(call => call.profile === 'grounded' && call.id === 'guesthouse_wrong_register');
  assert.equal(registerCalls.length, 2, 'Two frozen register repetitions required.');
  const template = registerCalls[0];
  assert.deepEqual(controlDocument.task, template.task, 'Diagnostic task must equal the frozen guesthouse task.');
  assert.equal(control.task_id, template.task.id, 'Control must use the frozen guesthouse task.');
  assert.equal(control.expected.expected_status, 'wrong_situation', 'Role reversal expected label required.');
  assert.equal(typeof control.text, 'string');
  assert(control.text.length > 50 && control.provenance, 'Authored control and provenance required.');
  const addendum = 'Zusätzliche allgemeine Präzisierung zur Statusentscheidung: Ein falsches oder uneinheitliches du/Sie-Register, eine unpassende Anrede oder ein unpassender Gruß allein ändern weder die kommunikativen Rollen noch den Schreibanlass. Wenn die Person weiterhin in der geforderten Rolle auf dieselbe Aufgabe antwortet, bleibt der Status assessed; verständlich behandelte Leitpunkte zählen unverändert. Solche Register- und Konventionsprobleme werden beim Kriterium Kommunikative Gestaltung berücksichtigt und schließen dort A aus. Verwende wrong_situation bei einer tatsächlichen Umkehr oder Verwechslung der kommunikativen Rollen oder einer deutlich anderen kommunikativen Handlung bei noch erkennbarem Schreibanlass. In diesem Fall setzt der Server nur Aufgabenbewältigung auf null; beurteile beide Sprachkriterien unabhängig anhand des vorhandenen Textes. Unvollständige Leitpunktabdeckung allein ist ebenfalls kein Rollenwechsel.';
  registerDiagnostic = { study: 'register_status_prompt_tuned_diagnostic', intendedComparison: 'Local correctability of an observed failure, not a controlled model head-to-head or a new holdout benchmark.', controlPath, controlHash: sha(controlText), control: controlDocument, addendum, addendumHash: sha(addendum), expectedLabelsSentToModel: false, originalRegisterRepetitions: 2, newRoleReversalRepetitions: 2 };
  calls.splice(0, calls.length, ...registerCalls.map(call => ({ ...call, diagnosticExpected: { status: 'assessed', task_completion: 5, communicative_design_below: 5 } })));
  for (let repeat = 1; repeat <= 2; repeat++) calls.push({ ...clone(template), id: control.id, repeat, entry: { id: control.id, task_id: control.task_id, text: control.text, expected: clone(control.expected) }, sourceRun: null, sourceModel: null, sourceMessagesHash: null, messages: [{ role: 'system', content: template.messages[0].content }, { role: 'user', content: JSON.stringify({ task: template.task, learner_response: control.text }) }], diagnosticExpected: { status: 'wrong_situation', task_completion: 0, retain_language_credit: true }, diagnosticControlProvenance: clone(control.provenance) });
  assert.equal(calls.length, 4);
  for (const call of calls) assert.deepEqual(JSON.parse(call.messages[1].content), { task: call.task, learner_response: call.entry.text });
}
if (args.includes('--include-probes')) {
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const string = { type: 'string' };
  const readingSchema = object({ title: string, passage: string, questions: { type: 'array', items: object({ question: string, options: object({ a: string, b: string, c: string }), answer: { type: 'string', enum: ['a', 'b', 'c'] }, evidence: string, explanation: string }) } });
  const listeningSchema = object({ announcements: { type: 'array', items: object({ script: string, statement: string, answer: { type: 'boolean' }, evidence: string, explanation: string }) } });
  const translationSchema = object({ language: { type: 'string', enum: ['ar', 'uk'] }, feedback_summary: string, next_step: string });
  calls.push({ kind: 'reading_generation', id: 'original_lv2', profile: 'probes', repeat: 1, schema: readingSchema, messages: [
    { role: 'system', content: 'Create original German B1 exam-practice material, not copied exam content. Return JSON matching the schema. Content will require qualified human review before use. Keep explanations in English and quoted evidence German.' },
    { role: 'user', content: 'Create one telc Deutsch B1 Leseverstehen Teil 2 style task set: one original coherent German passage of 250-350 words about a neighbourhood tool-sharing library, exactly five questions in passage order, each with exactly three plausible options a/b/c and one uniquely defensible answer. Include explicit evidence quoted exactly from the passage and an explanation for each answer. Vary answer positions. Avoid outside knowledge or ambiguous distractors.' },
  ] });
  calls.push({ kind: 'listening_generation', id: 'original_hv3_scripts', profile: 'probes', repeat: 1, schema: listeningSchema, messages: [
    { role: 'system', content: 'Create original German B1 listening-practice scripts, not copied exam content. Return JSON matching the schema. This is a script test only; audio and exam administration are not being evaluated. Explanations in English, exact evidence quotes in German.' },
    { role: 'user', content: 'Create exactly five independent short public announcements suitable for telc Deutsch B1 Hoerverstehen Teil 3 practice. Each German script must be 40-70 words. Use distinct transport, shop, sports centre, museum, and library situations. Supply one German true/false statement per script, its boolean answer, an exact evidence quote from the script and a short rationale. Include both true and false answers. False answers must be explicitly contradicted, not merely absent. Make at least two statements paraphrases rather than literal copies. No audio generation.' },
  ] });
  const originalRun = path.resolve(dir, '../mistral-feasibility/runs/2026-09-30T13-15-53-999Z/results.jsonl');
  const originalText = await fs.readFile(originalRun, 'utf8');
  const originalRows = originalText.trim().split(/\r?\n/).map(JSON.parse);
  const base = originalRows.find(row => row.model === 'mistral-small-2603' && row.id === 'plausible_b1_complete' && row.totalPoints !== undefined);
  assert(base, 'Frozen translation input required.');
  for (const language of ['ar', 'uk']) calls.push({ kind: 'translation', id: `feedback_${language}`, profile: 'probes', repeat: 1, schema: translationSchema, translationSource: { path: originalRun, hash: sha(originalText), model: base.model, id: base.id, repeat: base.repeat, completionId: base.completionId }, messages: [
    { role: 'system', content: 'Translate the existing practice feedback faithfully into the requested language. Preserve the meaning and German example phrases. Do not assess the learner, add claims or produce a score. Return only the supplied JSON structure.' },
    { role: 'user', content: JSON.stringify({ language, feedback_summary: base.output.feedback_summary, next_step: base.output.next_step }) },
  ] });
  // Validate manually copied probe wording against the existing benchmark source;
  // do not execute its top-level runner or make a Mistral request.
  const mistralRunner = await fs.readFile(path.resolve(dir, '../mistral-feasibility/run.mjs'), 'utf8');
  for (const call of calls.filter(call => call.profile === 'probes')) {
    assert(mistralRunner.includes(call.messages[0].content), 'Probe system prompt drift.');
    if (call.kind !== 'translation') assert(mistralRunner.includes(call.messages[1].content), 'Probe user prompt drift.');
    call.sourceMessagesHash = sha(JSON.stringify(call.messages));
    call.probeSource = { path: '../mistral-feasibility/run.mjs', hash: sha(mistralRunner), note: 'Same probe wording and schemas. Translation input frozen to the original Small 4 assessment, so its translation has identical input; Large used its own feedback originally.' };
  }
}
if (args.includes('--profile')) {
  const profile = option('--profile');
  assert(['baseline', 'grounded'].includes(profile), 'Unknown profile.');
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].profile !== profile) calls.splice(i, 1);
}
if (args.includes('--case')) {
  const id = option('--case');
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].id !== id) calls.splice(i, 1);
  assert(calls.length, 'Unknown case ID.');
}
calls.splice(limit);
for (const [i, call] of calls.entries()) {
  call.sequence = i + 1;
  call.model = config.model;
  call.maxTokens = maxTokens;
  call.originalMessages = clone(call.messages);
  if (registerDiagnostic) call.messages[0].content += '\n\n' + registerDiagnostic.addendum;
  // The provider does not offer Mistral's documented strict JSON-schema transport.
  // Preserve the rubric and learner text exactly; append only the previously external schema.
  call.messages[0].content += '\n\nOutput format only (the assessment rules above are unchanged): Return one JSON object, with no markdown or explanatory text outside it, matching this JSON Schema:\n' + JSON.stringify(call.schema);
  call.requestMessagesHash = sha(JSON.stringify(call.messages));
}
const criteria = ['task_completion', 'communicative_design', 'formal_accuracy'];
function schemaErrors(value, schema, at = '$') {
  const errors = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: object required`];
    for (const key of schema.required) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: missing`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) errors.push(`${at}.${key}: unexpected`);
      else errors.push(...schemaErrors(value[key], schema.properties[key], `${at}.${key}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${at}: array required`];
    value.forEach((v, i) => errors.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
  } else if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) errors.push(`${at}: ${schema.type} required`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: invalid enum`);
  return errors;
}
function canonicalAssessment(output, call) {
  if (call.profile === 'baseline') return { ...output, scoreSource: 'model_three_criteria' };
  const covered = Object.fromEntries(call.task.point_ids.map(id => [id, output.point_assessments[id].covered]));
  const zeroAll = ['off_topic', 'no_submission'].includes(output.status);
  const taskCompletion = zeroAll || output.status === 'wrong_situation' ? 0 : [0, 0, 1, 3, 5][Object.values(covered).filter(Boolean).length];
  return { status: output.status, covered_points: covered, raw_scores: { task_completion: taskCompletion, communicative_design: zeroAll ? 0 : output.language_scores.communicative_design, formal_accuracy: zeroAll ? 0 : output.language_scores.formal_accuracy }, criterion_reasons: output.criterion_reasons, feedback_summary: output.feedback_summary, corrections: output.corrections, next_step: output.next_step, scoreSource: 'content_derived_from_model_coverage_language_model_scored', derivedContentIsNotModelAccuracy: true };
}
function quoteErrors(output, call) {
  const errors = [];
  if (call.profile === 'grounded') for (const id of call.task.point_ids) {
    const point = output.point_assessments[id];
    if (point.covered && (!point.evidence.length || !call.entry.text.includes(point.evidence))) errors.push(`point_${id}: covered evidence is not exact learner text`);
    if (!point.covered && point.evidence !== '') errors.push(`point_${id}: uncovered evidence must be empty`);
  }
  output.corrections.forEach((c, i) => { if (!c.original.length || !call.entry.text.includes(c.original)) errors.push(`correction_${i}: original is not exact learner text`); });
  return errors;
}
function knownErrorCoverage(entry, corrections) {
  return (entry.expected.known_errors ?? entry.expected.known_deliberate_errors ?? []).map((error, i) => {
    const original = typeof error === 'string' ? error : error.original;
    const at = entry.text.indexOf(original);
    const indexes = corrections.flatMap((c, index) => {
      const start = entry.text.indexOf(c.original);
      return at >= 0 && start >= 0 && start < at + original.length && at < start + c.original.length ? [index] : [];
    });
    return { id: typeof error === 'string' ? `known_${i + 1}` : error.id, original, fixtureQuoteExists: at >= 0, candidateCorrectionIndexes: indexes, candidateSpanCovered: indexes.length > 0, validity: 'requires_human_review_no_exact_replacement_gold' };
  });
}
function assess(output, call) {
  const assessment = canonicalAssessment(output, call);
  const totalPoints = 3 * criteria.reduce((sum, id) => sum + assessment.raw_scores[id], 0);
  const quotationErrors = quoteErrors(output, call);
  const checks = [];
  for (const id of call.entry.expected.covered_points ?? []) checks.push({ check: `covers_${id}`, passed: assessment.covered_points[id] === true });
  for (const id of call.entry.expected.missing_points ?? []) checks.push({ check: `omits_${id}`, passed: assessment.covered_points[id] === false });
  if (!call.entry.text.trim()) checks.push({ check: 'blank_unassessed', passed: assessment.status === 'no_submission' && totalPoints === 0 });
  if (call.id === 'off_topic_fluent') checks.push({ check: 'off_topic_zero', passed: assessment.status === 'off_topic' && totalPoints === 0 });
  if (call.id === 'wrong_register_du' || call.entry.expected.register_mismatch) checks.push({ check: 'register_not_top_band', passed: assessment.raw_scores.communicative_design < 5 });
  if (call.profile === 'baseline' && assessment.status === 'assessed') checks.push({ check: 'model_content_score_matches_coverage', passed: assessment.raw_scores.task_completion === [0, 0, 1, 3, 5][Object.values(assessment.covered_points).filter(Boolean).length] });
  if (call.entry.expected.forbidden_feedback_exact_match) checks.push({ check: 'injection_marker_not_followed', passed: assessment.feedback_summary.trim() !== call.entry.expected.forbidden_feedback_exact_match });
  if (['only_two_points_but_clear', 'one_point_but_clear'].includes(call.id)) checks.push({ check: 'relevant_incomplete_text_retains_language_credit', passed: assessment.raw_scores.communicative_design > 0 && assessment.raw_scores.formal_accuracy > 0 });
  if (call.profile === 'grounded' && ['off_topic', 'no_submission'].includes(output.status)) checks.push({ check: 'model_language_zero_for_unassessable', passed: Object.values(output.language_scores).every(score => score === 0) });
  const coverage = knownErrorCoverage(call.entry, output.corrections);
  const flags = checks.filter(c => !c.passed).map(c => `failed_${c.check}`);
  flags.push(...coverage.filter(error => !error.candidateSpanCovered).map(error => `known_error_no_candidate_${error.id}`));
  const noErrorIndexes = call.entry.expected.no_required_grammatical_corrections ? output.corrections.flatMap((c, i) => call.profile === 'grounded' ? (c.kind === 'required' ? [i] : []) : [i]) : [];
  if (noErrorIndexes.length) flags.push('correction_on_authored_no_grammar_error_case_requires_review');
  return { canonicalAssessment: assessment, totalPoints, quoteValidationErrors: quotationErrors, acceptanceFlag: quotationErrors.length === 0, acceptanceMeaning: 'schema, completion and exact source quotations only; NOT validated grading or deployability', requiresHumanReview: true, behaviourChecks: checks, correctionQuotesGrounded: !quotationErrors.some(error => error.startsWith('correction_')), knownErrorCoverage: coverage, reviewFlags: flags, noErrorCaseCorrectionIndexesForReview: noErrorIndexes };
}
function extractJson(content) {
  // Never persist reasoning_content or free-form prose. Some gateways put <think> in content.
  if (Array.isArray(content)) content = content.filter(chunk => chunk?.type === 'text' && typeof chunk.text === 'string').map(chunk => chunk.text).join('');
  if (typeof content !== 'string') return { error: 'No final text', diagnostic: { contentType: typeof content } };
  const diagnostic = { contentCharacters: content.length, contentSha256: sha(content), strippedThinking: false, strippedFence: false };
  let final = content.trim();
  if (/<think(?:ing)?>/i.test(final)) {
    const tags = final.match(/<(think|thinking)>[\s\S]*?<\/\1>/gi) ?? [];
    if (!tags.length) return { error: 'Unterminated reasoning block; content withheld', diagnostic };
    for (const tag of tags) final = final.replace(tag, '');
    diagnostic.strippedThinking = true;
    final = final.trim();
  }
  const fenced = final.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) { final = fenced[1].trim(); diagnostic.strippedFence = true; }
  if (!final.startsWith('{') || !final.endsWith('}')) return { error: 'Final content is not a complete JSON object; unstructured content withheld', diagnostic };
  try { return { output: JSON.parse(final), diagnostic }; }
  catch { return { error: 'Invalid JSON response; unstructured content withheld', diagnostic }; }
}
function requestBody(call) {
  return { model: config.model, messages: call.messages, top_p: 1, max_tokens: call.maxTokens, stream: false, reasoning_effort: effort,
    ...(provider === 'greenpt' || effort === 'none' ? { temperature: 0 } : {}),
    ...(provider === 'deepseek' ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' }, response_format: { type: 'json_object' } } : {}) };
}
function usageMetadata(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const keep = (object, names) => Object.fromEntries(names.filter(name => Number.isFinite(object?.[name])).map(name => [name, object[name]]));
  return { ...keep(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']), prompt_tokens_details: keep(usage.prompt_tokens_details, ['cached_tokens']), completion_tokens_details: keep(usage.completion_tokens_details, ['reasoning_tokens']) };
}
function costEstimate(usage) {
  if (!Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) return null;
  const cached = Math.max(0, Math.min(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0));
  return ((usage.prompt_tokens - cached) * config.input + cached * config.cached + usage.completion_tokens * config.output) / 1e6;
}
const reservation = call => (Buffer.byteLength(JSON.stringify(requestBody(call)), 'utf8') + 8192) * config.input / 1e6 + call.maxTokens * config.output / 1e6;
const reserved = calls.reduce((sum, call) => sum + reservation(call), 0);
assert(reserved <= safetyLimit, 'Conservative reservation exceeds safety-limit.');

// Meaningful offline checks use saved model outputs to ensure identical scorer behavior.
let checks = 0;
for (const source of sources) {
  const rows = (await fs.readFile(path.join(path.dirname(source.path), 'results.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  for (const row of rows.filter(row => row.output && row.validationErrors?.length === 0)) {
    const call = calls.find(call => call.profile === source.profile && call.id === row.id && call.repeat === row.repeat);
    if (!call) continue;
    assert.deepEqual(schemaErrors(row.output, call.schema), []);
    const result = assess(row.output, call);
    assert.equal(result.totalPoints, row.totalPoints);
    assert.deepEqual(result.canonicalAssessment.raw_scores, row.canonicalAssessment?.raw_scores ?? row.output.raw_scores);
    if (row.quoteValidationErrors) assert.deepEqual(result.quoteValidationErrors, row.quoteValidationErrors);
    else assert.equal(result.correctionQuotesGrounded, row.correctionQuotesGrounded);
    assert.deepEqual(result.behaviourChecks, row.behaviourChecks.map(check => ({ ...check, check: check.check === 'content_score_matches_coverage' ? 'model_content_score_matches_coverage' : check.check })));
    if (row.knownErrorCoverage) assert.deepEqual(result.knownErrorCoverage, row.knownErrorCoverage);
    else assert(Array.isArray(result.knownErrorCoverage));
    checks += 6;
  }
}
assert.deepEqual(extractJson('<think>PRIVATE REASONING</think>{"x":1}').output, { x: 1 });
assert(extractJson('<think>PRIVATE REASONING').error);
assert(extractJson('PRIVATE REASONING then {"x":1}').error);
assert.deepEqual(extractJson('```json\n{"x":1}\n```').output, { x: 1 });
assert.deepEqual(extractJson([{ type: 'thinking', text: 'PRIVATE' }, { type: 'text', text: '{"x":1}' }]).output, { x: 1 });
assert(schemaErrors({ extra: true }, calls[0].schema).length > 0);
assert.equal(costEstimate({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500 } }), (500 * config.input + 500 * config.cached + 200 * config.output) / 1e6);
checks += 7;
if (!live) {
  console.log(JSON.stringify({ mode: 'offline_preflight', study: registerDiagnostic?.study ?? 'matched_comparison', provider, endpoint: config.endpoint, model: config.model, profiles: [...new Set(calls.map(call => call.profile))], plannedCalls: calls.length, effort, maxTokens, timeoutMs, concurrency, outputFormat: config.format, conservativeReservation: reserved, currency: config.currency, validationChecks: checks, networkCalls: 0, secretsAccessed: false, sources: sources.map(({ fixture, ...source }) => source) }, null, 2));
  process.exit(0);
}
assert(args.includes('--key-stdin'), 'Live execution requires --key-stdin. Never provide an API key as an argument.');
let apiKey = '';
for await (const chunk of process.stdin) { apiKey += chunk.toString('utf8'); assert(apiKey.length <= 4096, 'Credential input too long.'); }
apiKey = apiKey.trim();
assert(apiKey && !/\s/.test(apiKey), 'Credential must be one nonempty API token.');
const clean = value => JSON.parse(JSON.stringify(value).split(apiKey).join('[REDACTED]'));
const started = new Date().toISOString();
const runDir = path.join(dir, 'runs', started.replace(/[:.]/g, '-'));
await fs.mkdir(runDir, { recursive: true });
const results = [];
let aborted = false, abortReason = null, queue = Promise.resolve();
const protocol = { suite: 'hatoove-deepseek-matched-v1', started, provider, endpoint: config.endpoint, model: config.model, effort, maxTokens, timeoutMs, concurrency, config, pricesVerifiedOn: '2026-09-30', safetyLimit, reserved, sources, calls, syntheticOnly: true, expertValidated: false, automaticRetries: 0, preflight: 'GET models followed by the first scored call; batch starts only after complete valid JSON', thinkingRetention: 'none; separate reasoning ignored; tagged blocks stripped; unstructured content and schema-invalid values withheld', differencesFromMistral: ['Same original semantic system/user messages and schemas; schema appended to system instead of Mistral strict json_schema transport.', provider === 'greenpt' ? 'GreenPT does not document response_format; prompt-only JSON selected, not guaranteed constrained decoding.' : 'DeepSeek Chat Completion documents json_object. Thinking ignores temperature; no temperature sent in high mode.', 'Provider reasoning settings and weights differ; high labels are not equal compute budgets.'], officialSources: [config.priceSource, 'https://docs.greenpt.ai/chat-completion', 'https://docs.greenpt.ai/reasoning', 'https://api-docs.deepseek.com/guides/thinking_mode/', 'https://api-docs.deepseek.com/guides/json_mode/'] };
protocol.study = registerDiagnostic?.study ?? 'matched_comparison';
if (registerDiagnostic) {
  protocol.suite = 'hatoove-deepseek-register-diagnostic-v1';
  protocol.registerDiagnostic = registerDiagnostic;
  protocol.differencesFromMistral.push('This separate diagnostic appends a prompt clarification after observing DeepSeek failures and adds a new role-reversal control; it is NOT the original matched comparison.');
}
await fs.writeFile(path.join(runDir, 'protocol.json'), JSON.stringify(protocol, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ phase: 'starting', runDir, provider, model: config.model, plannedCalls: calls.length }));
async function runCall(call) {
  const record = { sequence: call.sequence, kind: call.kind, id: call.id, taskId: call.taskId, model: config.model, repeat: call.repeat, profile: call.profile, provider, endpoint: config.endpoint, reasoningEffort: effort, maxTokens: call.maxTokens, requestedAt: new Date().toISOString(), costCurrency: config.currency, reservedCost: reservation(call) };
  const timer = performance.now();
  try {
    const response = await fetch(config.endpoint + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody(call)) });
    record.httpStatus = response.status;
    record.requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    record.retryAfter = response.headers.get('retry-after');
    if (!response.ok) {
      record.error = `HTTP_${response.status}`;
      record.apiError = (await response.text()).split(apiKey).join('[REDACTED]').slice(0, 2000);
      // Never issue a whole batch with rejected parameters, credentials, or capacity.
      aborted = true; abortReason = record.error;
    } else {
      const data = await response.json();
      record.responseModel = data.model;
      const responseModelMatches = provider === 'greenpt' ? data.model === 'deepseek-v4.1-flash' : ['deepseek-flash', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'].includes(data.model);
      record.responseModelMatches = responseModelMatches;
      if (!responseModelMatches) { aborted = true; abortReason = 'RESPONSE_MODEL_MISMATCH'; record.error = abortReason; }
      record.completionId = data.id;
      record.systemFingerprint = data.system_fingerprint ?? null;
      record.finishReason = data.choices?.[0]?.finish_reason;
      record.usage = usageMetadata(data.usage);
      record.costEstimate = costEstimate(record.usage);
      record.costEstimateBasis = provider === 'deepseek' ? 'peak-rate upper estimate; actual may be half' : 'published EUR rates and reported cache tokens';
      const parsed = extractJson(data.choices?.[0]?.message?.content);
      record.contentDiagnostic = parsed.diagnostic;
      record.validationErrors = parsed.error ? [parsed.error] : schemaErrors(parsed.output, call.schema);
      if (record.finishReason !== 'stop') record.validationErrors.push(`Incomplete finish: ${record.finishReason}`);
      if (!responseModelMatches) record.validationErrors.push('Response model does not match requested V4.1 Flash identity');
      record.schemaValid = record.validationErrors.length === 0;
      record.acceptanceFlag = false;
      if (record.schemaValid) {
        record.output = parsed.output;
        record.rawContent = JSON.stringify(parsed.output);
        if (call.kind === 'grading') Object.assign(record, assess(parsed.output, call));
        if (call.diagnosticExpected) {
          const expected = call.diagnosticExpected, actual = record.canonicalAssessment;
          record.diagnosticChecks = [
            { check: 'expected_status', passed: actual.status === expected.status },
            { check: 'expected_task_completion', passed: actual.raw_scores.task_completion === expected.task_completion },
          ];
          if (expected.communicative_design_below !== undefined) record.diagnosticChecks.push({ check: 'register_excludes_top_communication_band', passed: actual.raw_scores.communicative_design < expected.communicative_design_below });
          if (expected.retain_language_credit) record.diagnosticChecks.push({ check: 'role_reversal_retains_language_credit', passed: actual.raw_scores.communicative_design > 0 && actual.raw_scores.formal_accuracy > 0 });
          record.diagnosticInterpretation = 'Prompt-tuned local diagnostic, not unbiased benchmark accuracy or expert score validation.';
        }
        if (call.kind === 'translation') record.languageMatchesRequest = parsed.output.language === call.id.slice('feedback_'.length);
        if (call.kind === 'reading_generation') record.contentChecks = { fiveQuestions: parsed.output.questions.length === 5, wordCount: parsed.output.passage.trim().split(/\s+/).length, evidenceExact: parsed.output.questions.every(q => q.evidence.length > 0 && parsed.output.passage.includes(q.evidence)), answerPositions: parsed.output.questions.map(q => q.answer) };
        if (call.kind === 'listening_generation') record.contentChecks = { fiveAnnouncements: parsed.output.announcements.length === 5, wordCounts: parsed.output.announcements.map(a => a.script.trim().split(/\s+/).length), evidenceExact: parsed.output.announcements.every(a => a.evidence.length > 0 && a.script.includes(a.evidence)), mixedAnswers: new Set(parsed.output.announcements.map(a => a.answer)).size === 2 };
      } else {
        record.outputWithheld = 'Invalid-schema or unstructured output is not persisted because gateway may combine reasoning and answer.';
      }
      if (record.finishReason === 'length' || record.finishReason === 'model_length' || (parsed.error && !parsed.output)) { aborted = true; abortReason = record.finishReason === 'length' ? 'OUTPUT_BUDGET_EXHAUSTED: explicit rerun with larger max-tokens required' : 'NO_COMPLETE_FINAL_JSON: inspect protocol before rerun'; }
    }
  } catch (error) {
    record.error = ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'TRANSPORT_OR_PARSE_FAILURE';
    aborted = true; abortReason = record.error;
  }
  record.latencyMs = Math.round(performance.now() - timer);
  const safe = clean(record);
  results.push(safe);
  queue = queue.then(() => fs.appendFile(path.join(runDir, 'results.jsonl'), JSON.stringify(safe) + '\n'));
  await queue;
  console.log(JSON.stringify({ completed: results.length, id: safe.id, profile: safe.profile, repeat: safe.repeat, http: safe.httpStatus, ms: safe.latencyMs, points: safe.totalPoints, structureAccepted: safe.acceptanceFlag, error: safe.error, validationErrors: safe.validationErrors, reviewFlags: safe.reviewFlags, costEstimate: safe.costEstimate, currency: config.currency }));
  return safe;
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null; }
function summarize(profile) {
  const selected = calls.filter(call => call.profile === profile);
  const all = results.filter(row => row.profile === profile);
  if (profile === 'probes') return { profile, planned: selected.length, attempts: all.length, complete: all.length === selected.length, schemaValid: all.filter(row => row.schemaValid).length, estimatedCost: all.reduce((sum, row) => sum + (row.costEstimate ?? 0), 0), currency: config.currency, contentResults: all.map(row => ({ id: row.id, kind: row.kind, checks: row.contentChecks, languageMatchesRequest: row.languageMatchesRequest })) };
  const valid = all.filter(row => row.schemaValid);
  const ids = [...new Set(selected.map(call => call.id))];
  const scoreGroups = ids.map(id => { const rows = valid.filter(row => row.id === id).sort((a, b) => a.repeat - b.repeat); const scores = rows.map(row => row.totalPoints); return { id, scores, range: scores.length ? Math.max(...scores) - Math.min(...scores) : null, rawScores: rows.map(row => row.canonicalAssessment.raw_scores) }; });
  const injectionPairs = valid.filter(row => row.id.includes('injection') && selected.find(call => call.id === row.id)?.entry.expected.paired_with).map(row => { const entry = selected.find(call => call.id === row.id).entry; const base = valid.find(base => base.id === entry.expected.paired_with && base.repeat === row.repeat); return { id: row.id, repeat: row.repeat, base: base?.totalPoints, injected: row.totalPoints, increase: base ? row.totalPoints - base.totalPoints : null }; });
  const behavior = valid.flatMap(row => row.behaviourChecks);
  return { profile, planned: selected.length, attempts: all.length, schemaValid: valid.length, structureAccepted: valid.filter(row => row.acceptanceFlag).length, structuralAcceptanceIsGradingAccuracy: false, complete: all.length === selected.length, medianGradingMs: percentile(valid.map(row => row.latencyMs), .5), p95GradingMs: percentile(valid.map(row => row.latencyMs), .95), estimatedCost: all.reduce((sum, row) => sum + (row.costEstimate ?? 0), 0), currency: config.currency, behaviorPassed: behavior.filter(c => c.passed).length, behaviorTotal: behavior.length, behaviorExcludesDerivedArithmetic: profile === 'grounded', scoreGroups, injectionPairs, quoteFailures: valid.filter(row => row.quoteValidationErrors.length).map(row => ({ id: row.id, repeat: row.repeat, errors: row.quoteValidationErrors })), reviewFlags: valid.filter(row => row.reviewFlags.length).map(row => ({ id: row.id, repeat: row.repeat, flags: row.reviewFlags })), knownErrorCandidateSpanCoverage: valid.flatMap(row => row.knownErrorCoverage.map(error => ({ caseId: row.id, repeat: row.repeat, ...error }))) };
}
try {
  const response = await fetch(config.endpoint + '/models', { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + apiKey } });
  const meta = { httpStatus: response.status, requestedAt: new Date().toISOString() };
  if (!response.ok) { aborted = true; abortReason = `MODEL_CHECK_HTTP_${response.status}`; }
  else {
    const available = (await response.json()).data;
    const match = Array.isArray(available) ? available.find(model => model.id === config.model) : null;
    if (!match) { aborted = true; abortReason = 'REQUESTED_MODEL_NOT_AVAILABLE'; }
    else {
      meta.selectedModel = Object.fromEntries(['id', 'name', 'created', 'owned_by', 'context_window', 'max_output_tokens'].filter(key => match[key] !== undefined).map(key => [key, match[key]]));
      if (provider === 'deepseek' && match.name && !/v4[.]1[- ]flash/i.test(match.name)) { aborted = true; abortReason = 'MODEL_ALIAS_NO_LONGER_IDENTIFIES_V4_1_FLASH'; }
    }
  }
  await fs.writeFile(path.join(runDir, 'model-check.json'), JSON.stringify(clean(meta), null, 2), { flag: 'wx' });
  if (!aborted) {
    const first = await runCall(calls[0]);
    if (!first.schemaValid) { aborted = true; abortReason ??= 'PREFLIGHT_INVALID_SCHEMA'; }
  }
  let next = 1;
  if (!aborted) await Promise.all(Array.from({ length: concurrency }, async () => { while (!aborted && next < calls.length) await runCall(calls[next++]); }));
} catch (error) { aborted = true; abortReason = error.name === 'TimeoutError' ? 'MODEL_CHECK_TIMEOUT' : 'MODEL_CHECK_OR_RUN_FAILURE'; }
finally {
  const summary = { started, finished: new Date().toISOString(), provider, endpoint: config.endpoint, model: config.model, effort, maxTokens, plannedCalls: calls.length, completedCalls: results.length, aborted, abortReason, syntheticOnly: true, expertValidated: false, costCurrency: config.currency, estimatedTotalCost: results.reduce((sum, row) => sum + (row.costEstimate ?? 0), 0), actualInvoiceNotVerified: true, results: [...new Set(calls.map(call => call.profile))].map(summarize), limitations: ['Synthetic responses have no independent examiner score gold standard.', 'Exact quotations and content flags are not grammar or examiner accuracy.', 'Grounded task-completion arithmetic is implemented in code.', 'High reasoning differs across providers; format-control transport differs from Mistral.', 'No audio, production integration or real learner data tested.'], failures: results.filter(row => row.error || !row.schemaValid).map(row => ({ id: row.id, repeat: row.repeat, profile: row.profile, error: row.error, validationErrors: row.validationErrors })) };
  summary.study = registerDiagnostic?.study ?? 'matched_comparison';
  if (registerDiagnostic) {
    summary.diagnosticResults = results.map(row => ({ id: row.id, repeat: row.repeat, status: row.canonicalAssessment?.status, scores: row.canonicalAssessment?.raw_scores, checks: row.diagnosticChecks }));
    summary.limitations.unshift('Prompt-tuned diagnostic after an observed failure: one original register case twice and one new authored role-reversal control twice; not an unbiased held-out accuracy estimate.');
  }
  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(clean(summary), null, 2), { flag: 'wx' });
  apiKey = '';
  console.log(JSON.stringify({ reportDirectory: runDir, completedCalls: results.length, plannedCalls: calls.length, aborted, abortReason, estimatedTotalCost: summary.estimatedTotalCost, currency: config.currency }, null, 2));
  if (aborted) process.exitCode = 2;
}

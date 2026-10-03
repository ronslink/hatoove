/** Pure dictionary controls; all output is synthetic, not educational/native approval. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../server/package-contract.mjs';
import { stubGrade } from '../server/owned-postgres/worker.mjs';
import { DTZ_POLICY, DTZ_KEYS } from '../server/writing-policy.mjs';
import { SIMULATION_LANGUAGES, SIMULATION_DICTIONARY_VERSION, SIMULATION_DICTIONARY_SHA256, simulationExplanationVariants } from '../server/explanation-simulation.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
let passed = 0;
const check = (name, fn) => {fn(); passed++; console.log('PASS '+name);};
function source(language = 'de', dtz = false, mutate = () => {}) {
  const assessment = stubGrade({text: 'Sehr geehrte Frau Weber, vielen Dank für Ihre Nachricht.', explanationLanguage: language,
    ...(dtz ? {policy: DTZ_POLICY, rubric: {criteria: DTZ_KEYS.map(key => ({key}))}} : {})});
  mutate(assessment);
  const identity = {model_version: assessment.modelVersion, prompt_version: assessment.promptVersion};
  const sourceObject = {format_version: 'explanation-source-v1', kind: 'writing', ...identity,
    original_language: language, original_format: assessment.feedback.kind, original_value: assessment.feedback};
  return {kind: 'writing', supported: true, identity, sourceObject, sourceSha256: hash(sourceObject),
    originalLanguage: language, originalFormat: assessment.feedback.kind,
    originalPayload: {schema: 'explanation-text-v1', blocks: assessment.feedback.criteria.map(c => ({slot: `criterion/${c.key}/comment`, text: c.comment}))}};
}
check('both exact built-in templates have four complete alternatives for every source language', () => {
  for (const dtz of [false, true]) for (const language of SIMULATION_LANGUAGES) {
    const original = source(language, dtz), before = canonicalJson(original);
    const variants = simulationExplanationVariants(original, {trustedBuiltin: true});
    assert.deepEqual(variants.map(v => v.language), SIMULATION_LANGUAGES.filter(v => v !== language));
    for (const variant of variants) {
      const expected = source(variant.language, dtz);
      assert.deepEqual(variant.payload, expected.originalPayload);
      assert.equal(variant.payload_sha256, hash(variant.payload));
      assert.equal(variant.source_sha256, original.sourceSha256);
      assert.equal(variant.version, SIMULATION_DICTIONARY_VERSION);
      assert.deepEqual(variant.provenance, {kind: 'builtin-simulation-dictionary', source_sha256: original.sourceSha256,
        dictionary_version: SIMULATION_DICTIONARY_VERSION, dictionary_sha256: SIMULATION_DICTIONARY_SHA256});
    }
    assert.equal(canonicalJson(original), before, 'Source assessment/evidence/bands mutated');
  }
});
check('identical names and text without internally trusted default provenance yield no variants', () => {
  assert.deepEqual(simulationExplanationVariants(source()), []);
  assert.deepEqual(simulationExplanationVariants(source(), {trustedBuiltin: false}), []);
  assert.deepEqual(simulationExplanationVariants(source(), {trustedBuiltin: 'true'}), []);
});
check('unknown substantive comment never becomes generic dictionary prose', () => {
  assert.deepEqual(simulationExplanationVariants(source('de', false, a => {a.feedback.criteria[0].comment = 'Eine andere inhaltliche Rückmeldung.';}), {trustedBuiltin: true}), []);
});
check('unknown correction prevents every optional variant, even with all known comments', () => {
  assert.deepEqual(simulationExplanationVariants(source('de', false, a => {a.feedback.corrections.push('Eine unbekannte Korrektur.');}), {trustedBuiltin: true}), []);
});
check('unknown language/model/prompt/kind and malformed slot shapes fail closed', () => {
  const mutations = [s => {s.originalLanguage = null;}, s => {s.originalLanguage = 'fr';}, s => {s.supported = false;},
    s => {s.identity.model_version = 'custom';}, s => {s.identity.prompt_version = 'custom';},
    s => {s.originalFormat = 'legacy-comment';}, s => {s.kind = 'objective';},
    s => {s.originalPayload.blocks.pop();}, s => {s.originalPayload.blocks[0].text += ' ';},
    s => {s.sourceSha256 = '0'.repeat(64);}];
  for (const mutate of mutations) {const s = source(); mutate(s); assert.deepEqual(simulationExplanationVariants(s, {trustedBuiltin: true}), []);}
});
check('exact template match retains criterion order and rejects duplicated or unknown keys', () => {
  const reordered = source('de', false, a => a.feedback.criteria.reverse());
  assert.deepEqual(simulationExplanationVariants(reordered, {trustedBuiltin: true})[0].payload.blocks.map(b => b.slot), reordered.originalPayload.blocks.map(b => b.slot));
  for (const key of ['unrecognised', 'kommunikation']) {
    assert.deepEqual(simulationExplanationVariants(source('de', false, a => {a.feedback.criteria[0].key = key;}), {trustedBuiltin: true}), []);
  }
});
check('fresh variants cannot mutate the versioned dictionary for subsequent assessments', () => {
  const original = source(), first = simulationExplanationVariants(original, {trustedBuiltin: true});
  first[0].payload.blocks[0].text = 'modified';
  assert.notEqual(simulationExplanationVariants(original, {trustedBuiltin: true})[0].payload.blocks[0].text, 'modified');
  assert.match(SIMULATION_DICTIONARY_SHA256, /^[a-f0-9]{64}$/);
});
console.log(`${passed} explanation worker pure checks passed`);

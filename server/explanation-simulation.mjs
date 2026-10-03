/** Authored simulation prose only. This module never grades, calls providers or writes storage. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './package-contract.mjs';
import { DTZ_KEYS } from './writing-policy.mjs';

export const SIMULATION_DICTIONARY_VERSION = 'simulation-explanations-v1';
export const SIMULATION_LANGUAGES = Object.freeze(['de', 'en', 'uk', 'ar', 'tr']);
const telc = Object.freeze({
  de: 'Vorläufige Rückmeldung ohne Modell (Übungsbetrieb).',
  en: 'Provisional feedback without a model (practice mode).',
  uk: 'Попередній відгук без моделі (режим практики).',
  ar: 'ملاحظات مبدئية بدون نموذج (وضع التدريب).',
  tr: 'Model olmadan geçici geri bildirim (alıştırma kipi).',
});
const dtz = Object.freeze({
  de: 'Simulation ohne Sprachbewertung: Diese feste Beispielposition bewertet Ihren Text nicht.',
  en: 'Simulation without language assessment: this fixed example position does not assess your text.',
  uk: 'Симуляція без мовного оцінювання: ця фіксована позиція не оцінює ваш текст.',
  ar: 'محاكاة دون تقييم لغوي: هذا المثال الثابت لا يقيّم نصك.',
  tr: 'Dil değerlendirmesi olmadan simülasyon: bu sabit örnek metninizi değerlendirmez.',
});
const templates = Object.freeze({
  'stub-grader-v2': Object.freeze({ kind: 'telc-b1-bands', keys: Object.freeze(['aufgabe', 'kommunikation', 'richtigkeit']), comments: telc }),
  'dtz-simulation-v1': Object.freeze({ kind: 'dtz-writing-bands', keys: DTZ_KEYS, comments: dtz }),
});
const hash = value => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
export const SIMULATION_DICTIONARY_SHA256 = hash({version: SIMULATION_DICTIONARY_VERSION, templates});

/**
 * `trustedBuiltin` is captured by createWorker from whether a grader was injected, never
 * read from the grader response. Even a byte-identical injected grader is custom.
 * Unknown templates, corrections and unsupported sources produce no optional variants.
 * Original-language persistence belongs to the caller and is independent of this match.
 */
export function simulationExplanationVariants(source, {trustedBuiltin = false} = {}) {
  if (trustedBuiltin !== true || source?.kind !== 'writing' || source.supported !== true
    || !SIMULATION_LANGUAGES.includes(source.originalLanguage)) return [];
  const template = templates[source.identity?.model_version];
  const feedback = source.sourceObject?.original_value;
  if (!template || source.identity.prompt_version !== source.identity.model_version
    || source.originalFormat !== template.kind || feedback?.kind !== template.kind
    || !Array.isArray(feedback.criteria) || feedback.criteria.length !== template.keys.length
    || !Array.isArray(feedback.corrections) || feedback.corrections.length !== 0) return [];
  if (!/^[a-f0-9]{64}$/.test(source.sourceSha256 || '') || hash(source.sourceObject) !== source.sourceSha256) return [];
  const expected = feedback.criteria.map(criterion => ({slot: `criterion/${criterion.key}/comment`, text: criterion.comment}));
  if (new Set(feedback.criteria.map(c => c.key)).size !== template.keys.length
    || feedback.criteria.some(c => !template.keys.includes(c.key) || c.comment !== template.comments[source.originalLanguage])
    || canonicalJson(source.originalPayload) !== canonicalJson({schema: 'explanation-text-v1', blocks: expected})) return [];
  return SIMULATION_LANGUAGES.filter(language => language !== source.originalLanguage).map(language => {
    const payload = {schema: 'explanation-text-v1', blocks: expected.map(({slot}) => ({slot, text: template.comments[language]}))};
    return {
      language, version: SIMULATION_DICTIONARY_VERSION, source_sha256: source.sourceSha256,
      payload, payload_sha256: hash(payload),
      provenance: {kind: 'builtin-simulation-dictionary', source_sha256: source.sourceSha256,
        dictionary_version: SIMULATION_DICTIONARY_VERSION, dictionary_sha256: SIMULATION_DICTIONARY_SHA256},
    };
  });
}

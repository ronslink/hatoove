#!/usr/bin/env node
/**
 * EXAM-S2 — scoped offline check for the source package documents and their fixtures.
 *
 * What this tool is
 * -----------------
 * A read-only structural check over the three source documents owned by this execution:
 *
 *   content/exams/telc-deutsch-b1/manifest.json
 *   content/fixtures/exams/dtz-internal.json
 *   content/fixtures/exams/english-scale.json
 *
 * It encodes the structural rules of `docs/contracts/EXAM-S2.md`: the package input shape, exam
 * language / level model / objective scale as DATA, the explicit version strings, the supported
 * interaction set, complete declared section/part/item coverage for a form, no secret field in a
 * learner-visible payload, legal answer options, and the rule that a partial fixture can never be
 * an `available` release. It writes nothing and imports no application code.
 *
 * What this tool is NOT
 * ---------------------
 * It is NOT the package validator. `server/package-contract.mjs` (owning `validatePackage`,
 * `canonicalJson`, `packageHash`) is root/coordinator-owned and does not exist yet. The
 * contract-level cases are therefore reported PENDING — never "passed" — until that module lands.
 * This tool deliberately implements no competing canonical-hash helper: inventing one would be a
 * second, silently divergent source of truth for the same identity.
 *
 * Usage
 * -----
 *   node tools/exam-s2-package-check.mjs                       # structural check of the three documents
 *   node tools/exam-s2-package-check.mjs --source-root <dir>   # repo root that will hold server/package-contract.mjs
 *   node tools/exam-s2-package-check.mjs --self-test           # also run the local negative mutations
 *   node tools/exam-s2-package-check.mjs --self-test --require-contract
 *
 * Environment
 * -----------
 *   EXAM_S2_PACKAGE_CONTRACT  absolute path to the root-owned module, if it lives outside
 *                             <source-root>/server/package-contract.mjs
 *
 * Exit codes: 0 all executed checks passed (PENDING contract cases are reported, not passed);
 * 1 an executed check failed; 2 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE_ROOT = path.resolve(HERE, '..');

export const CONTRACT_MODULE_RELATIVE = path.join('server', 'package-contract.mjs');
export const CONTRACT_MODULE_ENV = 'EXAM_S2_PACKAGE_CONTRACT';
export const CONTRACT_EXPORTS = ['validatePackage', 'canonicalJson', 'packageHash'];

/** Interactions a saved S2 form/member may actually use. */
export const SUPPORTED_INTERACTIONS = ['matching_headlines', 'single_choice', 'matching_ads', 'gap_choice', 'gap_bank'];
/** Interactions a blueprint may DOCUMENT without any form being allowed to reference them. */
export const DOCUMENTED_ONLY_INTERACTIONS = ['fixed_audio', 'extended_writing'];
export const RELEASE_STATES = ['hidden', 'internal', 'available', 'withdrawn'];
export const ASSESSMENT_POLICY = 'objective-count-v1';
export const VERSION_PATTERN = /^v[0-9]+$/;
/** Fields that are answers, answer-adjacent, or protected media/transcript text. */
export const SECRET_FIELDS = new Set([
  'answer', 'answers', 'why', 'explanation', 'explanations', 'key', 'solution',
  'script', 'transcript', 'transcripts', 'media', 'audio',
]);

export const DOCUMENTS = [
  { label: 'telc manifest', kind: 'package', file: path.join('content', 'exams', 'telc-deutsch-b1', 'manifest.json') },
  { label: 'dtz-internal fixture', kind: 'fixture', file: path.join('content', 'fixtures', 'exams', 'dtz-internal.json') },
  { label: 'english-scale fixture', kind: 'fixture', file: path.join('content', 'fixtures', 'exams', 'english-scale.json') },
];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Family segment of a set id such as `telc-deutsch-b1.lv1.01` -> { examId, family }. */
export function parseSetId(setId, examId) {
  const prefix = `${examId}.`;
  if (!isNonEmptyString(setId) || !setId.startsWith(prefix)) return null;
  const rest = setId.slice(prefix.length);
  const m = rest.match(/^([a-z][a-z0-9]*)\.([0-9]{2})$/);
  if (!m) return null;
  return { examId, family: m[1], index: m[2] };
}

/** Recursively collect every key path whose key name is a secret field. */
function findSecretPaths(node, at = 'payload', depth = 0, out = []) {
  if (depth > 12 || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => findSecretPaths(child, `${at}[${i}]`, depth + 1, out));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) out.push(`${at}.${key}`);
    else findSecretPaths(value, `${at}.${key}`, depth + 1, out);
  }
  return out;
}

/**
 * Pure structural validator for one EXAM-S2 package document.
 * No I/O, no globals, no mutation of the argument.
 *
 * @param {unknown} doc parsed document
 * @param {{label?: string, kind?: 'package'|'fixture'}} [opts]
 * @returns {{ok: boolean, errors: string[], warnings: string[], summary: object}}
 */
export function checkPackageShape(doc, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push(`[${code}] ${detail}`);
  const warn = (code, detail) => warnings.push(`[${code}] ${detail}`);
  const label = opts.label || 'package';
  const kind = opts.kind || 'package';
  const summary = { examId: null, sections: 0, parts: 0, forms: 0, sets: 0, state: null };

  if (!isPlainObject(doc)) {
    err('schema.root', `${label}: document must be a JSON object`);
    return { ok: false, errors, warnings, summary };
  }
  if (doc.schemaVersion !== 1) {
    err('schema.version', `${label}: schemaVersion must be 1 (got ${JSON.stringify(doc.schemaVersion)})`);
  }

  /* ---------------------------------------------------------------- exam */
  if (!isPlainObject(doc.exam)) {
    err('exam.missing', `${label}: exam object is required`);
    return { ok: false, errors, warnings, summary };
  }
  const exam = doc.exam;
  if (!isNonEmptyString(exam.id)) err('exam.id', `${label}: exam.id must be a non-empty string`);
  else summary.examId = exam.id;
  if (!isNonEmptyString(exam.title)) err('exam.title', `${label}: exam.title must be a non-empty string`);
  if (!isNonEmptyString(exam.language) || !/^[a-z]{2}(-[A-Za-z0-9]+)*$/.test(exam.language)) {
    err('exam.language', `${label}: exam.language must be a language tag such as "de" or "en"`);
  }
  if (!isPlainObject(exam.levelModel)) {
    err('exam.level-model', `${label}: exam.levelModel is required`);
  } else {
    const lm = exam.levelModel;
    if (lm.type === 'cefr' || lm.type === 'cefr-range') {
      if (!Array.isArray(lm.levels) || lm.levels.length === 0 || !lm.levels.every(isNonEmptyString)) {
        err('exam.level-model-levels', `${label}: levelModel.levels must be a non-empty string array`);
      } else if (lm.type === 'cefr-range' && lm.levels.length < 2) {
        err('exam.level-model-range', `${label}: a cefr-range level model needs at least two levels`);
      }
    } else if (lm.type === 'band') {
      if (!Number.isInteger(lm.min) || !Number.isInteger(lm.max) || lm.min >= lm.max) {
        err('exam.level-model-band', `${label}: a band level model needs integer min < max`);
      }
    } else {
      err('exam.level-model-type', `${label}: levelModel.type "${lm.type}" is not supported`);
    }
  }

  /* ----------------------------------------------------------- blueprint */
  const sectionsById = new Map();
  const partFamilyToSection = new Map();
  if (!isPlainObject(doc.blueprint)) {
    err('blueprint.missing', `${label}: blueprint object is required`);
  } else {
    const bp = doc.blueprint;
    if (!isNonEmptyString(bp.version) || !VERSION_PATTERN.test(bp.version)) {
      err('blueprint.version', `${label}: blueprint.version must match "v<digits>"`);
    }
    if (!Array.isArray(bp.sections) || bp.sections.length === 0) {
      err('blueprint.sections', `${label}: blueprint.sections must be a non-empty array`);
    } else {
      bp.sections.forEach((section, si) => {
        const at = `blueprint.sections[${si}]`;
        if (!isPlainObject(section)) return err('section.type', `${at} must be an object`);
        const sidLabel = isNonEmptyString(section.id) ? section.id : at;
        if (!isNonEmptyString(section.id)) err('section.id', `${at}.id is required`);
        else if (sectionsById.has(section.id)) err('section.duplicate-id', `section id "${section.id}" is defined twice`);
        else sectionsById.set(section.id, section);
        if (!isNonEmptyString(section.title)) err('section.title', `${sidLabel}.title is required`);
        if (section.timeGroup !== null && !isNonEmptyString(section.timeGroup)) {
          err('section.time-group', `${sidLabel}.timeGroup must be null or a non-empty string`);
        }
        if (!Array.isArray(section.parts) || section.parts.length === 0) {
          err('section.parts', `${sidLabel}.parts must be a non-empty array`);
          return;
        }
        section.parts.forEach((part, pi) => {
          const pat = `${sidLabel}.parts[${pi}]`;
          if (!isPlainObject(part)) return err('part.type', `${pat} must be an object`);
          if (!isNonEmptyString(part.family)) err('part.family', `${pat}.family is required`);
          else if (partFamilyToSection.has(part.family)) {
            err('part.duplicate-family', `part family "${part.family}" is declared in two sections`);
          } else {
            partFamilyToSection.set(part.family, section.id);
          }
          if (!isPositiveInteger(part.itemCount)) err('part.item-count', `${pat}.itemCount must be a positive integer`);
          if (!isNonEmptyString(part.interaction)) {
            err('part.interaction', `${pat}.interaction is required`);
          } else if (!SUPPORTED_INTERACTIONS.includes(part.interaction)) {
            if (DOCUMENTED_ONLY_INTERACTIONS.includes(part.interaction)) {
              warn('part.documented-only', `${pat} documents interaction "${part.interaction}", which no form may reference`);
            } else {
              err('part.interaction-unknown', `${pat}.interaction "${part.interaction}" is neither supported nor documented`);
            }
          }
          if (typeof part.mediaRequired !== 'boolean') err('part.media-required', `${pat}.mediaRequired must be a boolean`);
        });
      });
    }
    if (!isPlainObject(bp.assessment)) {
      err('assessment.missing', `${label}: blueprint.assessment is required`);
    } else {
      const a = bp.assessment;
      if (!isNonEmptyString(a.policy)) err('assessment.policy', `${label}: assessment.policy is required`);
      else if (a.policy !== ASSESSMENT_POLICY) warn('assessment.policy-unknown', `${label}: assessment.policy "${a.policy}" is not "${ASSESSMENT_POLICY}"`);
      // The scale is DATA: it need not be a German integer scale, so only "finite number" is required.
      if (!isFiniteNumber(a.correct) || a.correct <= 0) err('assessment.correct', `${label}: assessment.correct must be a positive number`);
      if (!isFiniteNumber(a.incorrect) || a.incorrect < 0) err('assessment.incorrect', `${label}: assessment.incorrect must be a non-negative number`);
    }
    if (!Array.isArray(bp.sources) || bp.sources.length === 0) {
      err('blueprint.sources', `${label}: blueprint.sources must be a non-empty array`);
    } else {
      const seen = new Set();
      bp.sources.forEach((s, i) => {
        const at = `blueprint.sources[${i}]`;
        if (!isPlainObject(s)) return err('source.type', `${at} must be an object`);
        if (!isNonEmptyString(s.id)) err('source.id', `${at}.id is required`);
        else if (seen.has(s.id)) err('source.duplicate-id', `${at}.id "${s.id}" is duplicated`);
        else seen.add(s.id);
        if (!isNonEmptyString(s.url) && !isNonEmptyString(s.locatorNote)) err('source.locator', `${at} needs a url or a locatorNote`);
        if (!isNonEmptyString(s.retrieved) || !/^\d{4}-\d{2}-\d{2}$/.test(s.retrieved)) {
          err('source.retrieved', `${at}.retrieved must be YYYY-MM-DD`);
        }
        if (!isNonEmptyString(s.verification)) err('source.verification', `${at}.verification is required`);
      });
    }
  }

  /* -------------------------------------------------------------- release */
  if (!isPlainObject(doc.release)) {
    err('release.missing', `${label}: release object is required`);
  } else {
    const r = doc.release;
    if (!isNonEmptyString(r.version) || !VERSION_PATTERN.test(r.version)) err('release.version', `${label}: release.version must match "v<digits>"`);
    if (!RELEASE_STATES.includes(r.state)) err('release.state', `${label}: release.state "${r.state}" is not one of ${RELEASE_STATES.join(', ')}`);
    else summary.state = r.state;
    if (!Array.isArray(r.resumeBlockedReleases) || !r.resumeBlockedReleases.every(isNonEmptyString)) {
      err('release.resume-blocked', `${label}: release.resumeBlockedReleases must be an array of version strings`);
    } else if (r.resumeBlockedReleases.some((v) => !VERSION_PATTERN.test(v))) {
      err('release.resume-blocked-version', `${label}: release.resumeBlockedReleases entries must match "v<digits>"`);
    }
  }

  /* ----------------------------------------------------------------- sets */
  const setsByIdentity = new Map();
  if (!Array.isArray(doc.sets)) {
    err('sets.missing', `${label}: sets must be an array`);
  } else {
    summary.sets = doc.sets.length;
    doc.sets.forEach((set, i) => {
      const at = `sets[${i}]`;
      if (!isPlainObject(set)) return err('set.type', `${at} must be an object`);
      const slabel = isNonEmptyString(set.setId) ? set.setId : at;
      if (!isNonEmptyString(set.setId)) err('set.id', `${at}.setId is required`);
      if (!isNonEmptyString(set.version) || !VERSION_PATTERN.test(set.version)) err('set.version', `${slabel}.version must match "v<digits>"`);
      if (isNonEmptyString(set.setId) && isNonEmptyString(set.version)) {
        const identity = `${set.setId}@${set.version}`;
        if (setsByIdentity.has(identity)) err('set.duplicate', `set ${identity} is defined twice`);
        else setsByIdentity.set(identity, set);
      }
      if (isNonEmptyString(exam.id) && set.examId !== exam.id) {
        err('set.exam-ref', `${slabel}.examId "${set.examId}" does not match the document exam "${exam.id}"`);
      }
      const parsed = parseSetId(set.setId, exam.id);
      if (isNonEmptyString(exam.id) && !parsed) err('set.id-shape', `${slabel}.setId must be "<examId>.<family>.<NN>"`);
      if (isNonEmptyString(set.family)) {
        const owner = partFamilyToSection.get(set.family);
        if (!owner) err('set.family-unknown', `${slabel}.family "${set.family}" is not declared in the blueprint`);
        else if (set.section !== owner) err('set.section-mismatch', `${slabel}.section "${set.section}" does not match the section declaring family "${set.family}" (${owner})`);
        if (parsed && parsed.family !== set.family) err('set.family-shape', `${slabel}.setId family segment "${parsed.family}" does not match family "${set.family}"`);
      }
      if (!isNonEmptyString(set.section)) err('set.section', `${slabel}.section is required`);
      if (!isPositiveInteger(set.part)) err('set.part', `${slabel}.part must be a positive integer`);
      if (!isNonEmptyString(set.title)) err('set.title', `${slabel}.title is required`);
      if (!SUPPORTED_INTERACTIONS.includes(set.interaction)) {
        err('set.interaction', `${slabel}.interaction "${set.interaction}" is not supported`);
      }
      if (!isNonEmptyString(set.reviewStatus)) err('set.review-status', `${slabel}.reviewStatus is required`);
      if (!isNonEmptyString(set.rightsStatus)) err('set.rights-status', `${slabel}.rightsStatus is required`);
      if (!isNonEmptyString(set.source)) err('set.source', `${slabel}.source is required`);
      if (!isPositiveInteger(set.itemCount)) err('set.item-count', `${slabel}.itemCount must be a positive integer`);

      /* payload: learner-visible, so no secret may appear anywhere inside it */
      if (!isPlainObject(set.payload)) {
        err('set.payload', `${slabel}.payload must be an object`);
        return;
      }
      const secrets = findSecretPaths(set.payload, `${slabel}.payload`);
      for (const s of secrets) {
        err('set.payload-secret', `${s} exposes a protected answer/transcript field in a learner payload`);
      }
      if (!isPlainObject(set.answers)) err('set.answers', `${slabel}.answers must be an object`);
      if (!isPlainObject(set.explanations)) err('set.explanations', `${slabel}.explanations must be an object`);

      /* interaction shape */
      if (set.interaction === 'single_choice') {
        if (!isNonEmptyString(set.payload.text)) err('payload.text', `${slabel}.payload.text is required for single_choice`);
        if (!Array.isArray(set.payload.questions) || set.payload.questions.length === 0) {
          err('payload.questions', `${slabel}.payload.questions must be a non-empty array for single_choice`);
        } else {
          const optionKeys = new Map();
          const seenIds = new Set();
          set.payload.questions.forEach((q, qi) => {
            const qat = `${slabel}.payload.questions[${qi}]`;
            if (!isPlainObject(q)) return err('payload.question-type', `${qat} must be an object`);
            if (!isPositiveInteger(q.id)) err('payload.question-id', `${qat}.id must be a positive integer`);
            else if (seenIds.has(q.id)) err('payload.question-duplicate', `${qat}.id ${q.id} is repeated`);
            else seenIds.add(q.id);
            if (!isNonEmptyString(q.question)) err('payload.question-text', `${qat}.question is required`);
            if (!isPlainObject(q.options) || Object.keys(q.options).length === 0) {
              err('payload.options', `${qat}.options must be a non-empty object`);
            } else {
              for (const [k, v] of Object.entries(q.options)) {
                if (!isNonEmptyString(k)) err('payload.option-key', `${qat}.options has an empty key`);
                if (!isNonEmptyString(v)) err('payload.option-value', `${qat}.options.${k} must be a non-empty string`);
              }
              if (isPositiveInteger(q.id)) optionKeys.set(String(q.id), new Set(Object.keys(q.options)));
            }
          });
          if (isPositiveInteger(set.itemCount) && set.itemCount !== set.payload.questions.length) {
            err('set.item-count-mismatch', `${slabel}.itemCount ${set.itemCount} != ${set.payload.questions.length} payload question(s)`);
          }
          if (isPlainObject(set.answers)) {
            const answerKeys = Object.keys(set.answers);
            for (const qid of optionKeys.keys()) {
              if (!answerKeys.includes(qid)) err('set.answer-missing', `${slabel}.answers has no entry for item ${qid}`);
            }
            for (const [k, v] of Object.entries(set.answers)) {
              const options = optionKeys.get(k);
              if (!options) {
                err('set.answer-unknown-item', `${slabel}.answers references item ${k}, which is not in the payload`);
                continue;
              }
              if (!isNonEmptyString(v) || !options.has(v)) {
                err('set.answer-option', `${slabel}.answers.${k} = ${JSON.stringify(v)} is not one of the offered options (${[...options].join(', ')})`);
              }
            }
            if (isPlainObject(set.explanations)) {
              for (const k of Object.keys(set.explanations)) {
                if (!answerKeys.includes(k)) err('set.explanation-unknown-item', `${slabel}.explanations references item ${k}, which has no answer`);
              }
            }
          }
        }
      } else {
        warn('payload.shape-asserted', `${slabel}: interaction "${set.interaction}" payload shape is not asserted by this offline check`);
      }
    });
  }

  /* ---------------------------------------------------------------- forms */
  const formsById = new Map();
  if (!Array.isArray(doc.forms)) {
    err('forms.missing', `${label}: forms must be an array`);
  } else {
    summary.forms = doc.forms.length;
    doc.forms.forEach((form, fi) => {
      const at = `forms[${fi}]`;
      if (!isPlainObject(form)) return err('form.type', `${at} must be an object`);
      const flabel = isNonEmptyString(form.id) ? form.id : at;
      if (!isNonEmptyString(form.id)) err('form.id', `${at}.id is required`);
      else if (formsById.has(form.id)) err('form.duplicate-id', `form id "${form.id}" is defined twice`);
      else formsById.set(form.id, form);
      if (!isNonEmptyString(form.version) || !VERSION_PATTERN.test(form.version)) err('form.version', `${flabel}.version must match "v<digits>"`);
      if (!isNonEmptyString(form.title)) err('form.title', `${flabel}.title is required`);
      if (form.scope !== 'section') err('form.scope', `${flabel}.scope must be "section"`);
      if (form.mode !== 'untimed' && form.mode !== 'timed') err('form.mode', `${flabel}.mode must be "untimed" or "timed"`);
      if (form.mode === 'untimed' && form.timeLimitSeconds !== null) {
        err('form.time-limit', `${flabel} is untimed but declares timeLimitSeconds ${JSON.stringify(form.timeLimitSeconds)}`);
      }
      if (form.mode === 'timed' && !isPositiveInteger(form.timeLimitSeconds)) {
        err('form.time-limit-timed', `${flabel} is timed but timeLimitSeconds is not a positive integer`);
      }
      if (!isNonEmptyString(form.feedback)) err('form.feedback', `${flabel}.feedback is required`);
      if (!Array.isArray(form.sections) || form.sections.length === 0) {
        err('form.sections', `${flabel}.sections must be a non-empty array`);
      }
      const formSections = Array.isArray(form.sections) ? form.sections : [];
      for (const sid of formSections) {
        if (!sectionsById.has(sid)) err('form.section-unknown', `${flabel} declares section "${sid}", which the blueprint does not declare`);
      }
      if (!Array.isArray(form.members) || form.members.length === 0) {
        err('form.members', `${flabel}.members must be a non-empty array`);
        return;
      }
      const seenMembers = new Set();
      const memberFamilies = new Set();
      form.members.forEach((member, mi) => {
        const mat = `${flabel}.members[${mi}]`;
        if (!isPlainObject(member)) return err('member.type', `${mat} must be an object`);
        if (!isNonEmptyString(member.setId)) err('member.set-id', `${mat}.setId is required`);
        if (!isNonEmptyString(member.version) || !VERSION_PATTERN.test(member.version)) err('member.version', `${mat}.version must match "v<digits>"`);
        if (isNonEmptyString(member.setId) && isNonEmptyString(member.version)) {
          const identity = `${member.setId}@${member.version}`;
          if (seenMembers.has(identity)) err('member.duplicate', `${mat}: member ${identity} is included twice in ${flabel}`);
          else seenMembers.add(identity);
        }
        if (!SUPPORTED_INTERACTIONS.includes(member.interaction)) {
          err('member.interaction-unsupported', `${mat}.interaction "${member.interaction}" is not a supported S2 interaction`);
        }
        if (!isPositiveInteger(member.itemCount)) err('member.item-count', `${mat}.itemCount must be a positive integer`);

        const parsed = parseSetId(member.setId, exam.id);
        if (isNonEmptyString(exam.id) && !parsed) {
          err('member.set-ref', `${mat}.setId must be "<examId>.<family>.<NN>" for exam "${exam.id}"`);
          return;
        }
        if (parsed) {
          memberFamilies.add(parsed.family);
          const owner = partFamilyToSection.get(parsed.family);
          const part = owner ? (sectionsById.get(owner).parts || []).find((p) => p && p.family === parsed.family) : null;
          if (!part) {
            err('member.family-unknown', `${mat}.setId names family "${parsed.family}", which the blueprint does not declare`);
          } else {
            if (!formSections.includes(owner)) {
              err('member.outside-scope', `${mat} belongs to section ${owner}, which ${flabel} does not declare in sections`);
            }
            if (member.interaction !== part.interaction) {
              err('member.interaction-mismatch', `${mat}.interaction "${member.interaction}" does not match the declared part interaction "${part.interaction}"`);
            }
            if (member.itemCount !== part.itemCount) {
              err('member.item-count-mismatch', `${mat}.itemCount ${member.itemCount} does not match the declared part itemCount ${part.itemCount}`);
            }
          }
        }
      });
      /* coverage: a form must cover EVERY declared part of EVERY section it claims. */
      for (const sid of formSections) {
        const section = sectionsById.get(sid);
        if (!section || !Array.isArray(section.parts)) continue;
        for (const part of section.parts) {
          if (!isPlainObject(part) || !isNonEmptyString(part.family)) continue;
          if (!memberFamilies.has(part.family)) {
            err('form.coverage', `${flabel} declares section ${sid} but has no member for part family "${part.family}"; an incomplete form must not claim the section`);
          }
          if (!SUPPORTED_INTERACTIONS.includes(part.interaction)) {
            err('form.unsupported-coverage', `${flabel}: part family "${part.family}" documents interaction "${part.interaction}", which no form may reference, so section ${sid} cannot be covered`);
          }
        }
      }
    });
  }

  /* --------------------------------------------------- availability gate */
  if (summary.state === 'available') {
    const covered = new Set();
    for (const form of formsById.values()) {
      for (const sid of Array.isArray(form.sections) ? form.sections : []) covered.add(sid);
    }
    for (const [sid, section] of sectionsById) {
      if (!covered.has(sid)) {
        err('available.coverage', `${label}: release state "available" requires every written section; section ${sid} has no form`);
      }
      void section;
    }
    for (const set of setsByIdentity.values()) {
      if (set.reviewStatus !== 'reviewed') {
        err('available.review', `${label}: release state "available" but set ${set.setId}@${set.version} reviewStatus is "${set.reviewStatus}"`);
      }
      if (!isNonEmptyString(set.rightsStatus) || set.rightsStatus === 'unknown' || set.rightsStatus === 'unreviewed') {
        err('available.rights', `${label}: release state "available" but set ${set.setId}@${set.version} rightsStatus is "${set.rightsStatus}"`);
      }
    }
    if (summary.forms === 0) err('available.forms', `${label}: release state "available" with no form`);
  } else if (summary.state === 'internal') {
    warn('release.internal', `${label}: internal release; it must not be treated as learner-available`);
  }

  /* --------------------------------------------------------- fixture flag */
  if (kind === 'fixture') {
    if (!isPlainObject(doc.fixture)) {
      err('fixture.marker', `${label}: a fixture document must carry a top-level "fixture" marker`);
    } else {
      for (const flag of ['synthetic', 'generated', 'unreviewed', 'notForPublication']) {
        if (doc.fixture[flag] !== true) err('fixture.flag', `${label}: fixture.${flag} must be true`);
      }
      if (!isNonEmptyString(doc.fixture.purpose)) err('fixture.purpose', `${label}: fixture.purpose is required`);
    }
    if (summary.state !== 'internal') {
      err('fixture.state', `${label}: a synthetic fixture must stay internal (got "${summary.state}")`);
    }
  } else if (doc.fixture !== undefined) {
    warn('fixture.marker-unexpected', `${label}: carries a fixture marker but is checked as a package document`);
  }

  summary.sections = sectionsById.size;
  summary.parts = partFamilyToSection.size;
  return { ok: errors.length === 0, errors, warnings, summary };
}

/** Deep clone through JSON, which is the only identity the documents use. */
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Local, NON-CONTRACT negative mutations. These prove the structural check above is not vacuous.
 * They are NOT the contract tests: those require the root-owned module.
 */
export function localNegativeCases(docs) {
  const { manifest, dtz } = docs;
  const cases = [];
  const add = (name, doc, kind, expect) => cases.push({ name, doc, kind, expect });

  add('valid telc manifest accepted', clone(manifest), 'package', 'accept');
  add('valid DTZ fixture accepted', clone(dtz), 'fixture', 'accept');

  let m = clone(manifest);
  m.forms[0].members[0].setId = 'contract-english.lv1.01';
  add('changed exam reference rejected', m, 'package', 'reject');

  m = clone(manifest);
  delete m.forms[0].version;
  add('missing form version rejected', m, 'package', 'reject');

  m = clone(manifest);
  m.blueprint.version = '1';
  add('malformed blueprint version rejected', m, 'package', 'reject');

  m = clone(manifest);
  m.forms.push(clone(m.forms[0]));
  add('duplicate form rejected', m, 'package', 'reject');

  m = clone(manifest);
  m.forms[0].members.push(clone(m.forms[0].members[0]));
  add('duplicate member rejected', m, 'package', 'reject');

  m = clone(manifest);
  m.forms[0].members[0].interaction = 'fixed_audio';
  add('unsupported form interaction rejected', m, 'package', 'reject');

  m = clone(manifest);
  m.forms[0].sections = ['LV', 'SB', 'HV', 'SA'];
  add('written form without coverage rejected', m, 'package', 'reject');

  const d = clone(dtz);
  d.sets[0].payload.questions[0].answer = 'a';
  add('secret field inside payload rejected', d, 'fixture', 'reject');

  const d2 = clone(dtz);
  d2.sets[0].answers['1'] = 'z';
  add('answer outside the offered options rejected', d2, 'fixture', 'reject');

  const d3 = clone(dtz);
  d3.release.state = 'available';
  add('incomplete DTZ marked available rejected', d3, 'fixture', 'reject');

  const d4 = clone(dtz);
  for (const flag of ['synthetic', 'generated', 'unreviewed', 'notForPublication']) delete d4.fixture[flag];
  add('fixture marker removed rejected', d4, 'fixture', 'reject');

  return cases;
}

/** Run the local negative mutations and report whether each behaved as intended. */
export function runLocalSelfTest(docs, io = console) {
  const cases = localNegativeCases(docs);
  let failed = 0;
  io.log('  local negative mutations (structural check, NOT the contract tests):');
  for (const c of cases) {
    const r = checkPackageShape(c.doc, { label: c.name, kind: c.kind });
    const accepted = r.ok;
    const ok = c.expect === 'accept' ? accepted : !accepted;
    if (!ok) failed += 1;
    io.log(`    ${ok ? 'ok  ' : 'FAIL'} ${c.name} -> ${accepted ? 'accepted' : 'rejected'}${!ok && !r.ok ? ` (${r.errors[0]})` : ''}`);
  }
  return { ok: failed === 0, cases: cases.length, failed };
}

/** Build a mutated copy for a named contract case (kept in one place for both harness branches). */
function contractCase(name, docs) {
  const { manifest, dtz, english } = docs;
  switch (name) {
    case 'valid telc manifest': return { doc: clone(manifest), expect: 'accept' };
    case 'internal DTZ fixture': return { doc: clone(dtz), expect: 'accept' };
    case 'English alternative scale': return { doc: clone(english), expect: 'accept' };
    case 'changed exam reference': {
      const m = clone(manifest); m.forms[0].members[1].setId = 'contract-english.lv1.01'; return { doc: m, expect: 'reject' };
    }
    case 'missing version': {
      const m = clone(manifest); delete m.forms[0].members[2].version; return { doc: m, expect: 'reject' };
    }
    case 'duplicate form': {
      const m = clone(manifest); m.forms.push(clone(m.forms[0])); return { doc: m, expect: 'reject' };
    }
    case 'duplicate member': {
      const m = clone(manifest); m.forms[0].members.push(clone(m.forms[0].members[0])); return { doc: m, expect: 'reject' };
    }
    case 'unsupported interaction': {
      const m = clone(manifest); m.forms[0].members[2].interaction = 'fixed_audio'; return { doc: m, expect: 'reject' };
    }
    case 'pre-feedback secret in payload': {
      const d = clone(dtz); d.sets[0].payload.questions[0].why = 'leaked'; return { doc: d, expect: 'reject' };
    }
    case 'bad answer option': {
      const d = clone(dtz); d.sets[0].answers['1'] = 'c'; return { doc: d, expect: 'reject' };
    }
    case 'incomplete DTZ marked available': {
      const d = clone(dtz); d.release.state = 'available'; return { doc: d, expect: 'reject' };
    }
    case 'complete written form without coverage': {
      const m = clone(manifest);
      m.forms[0].sections = ['LV', 'SB', 'HV', 'SA'];
      return { doc: m, expect: 'reject' };
    }
    default: return null;
  }
}

export const CONTRACT_CASE_NAMES = [
  'valid telc manifest', 'internal DTZ fixture', 'English alternative scale', 'changed exam reference',
  'missing version', 'duplicate form', 'duplicate member', 'unsupported interaction',
  'pre-feedback secret in payload', 'bad answer option', 'incomplete DTZ marked available',
  'complete written form without coverage',
];

/** Resolve the root-owned validator module without inventing a replacement for it. */
export function resolveContractModule(sourceRoot) {
  const envPath = process.env[CONTRACT_MODULE_ENV];
  const abs = envPath ? path.resolve(envPath) : path.join(sourceRoot, CONTRACT_MODULE_RELATIVE);
  return { path: abs, fromEnv: Boolean(envPath), exists: fs.existsSync(abs) };
}

/**
 * Run the contract-level cases against the root-owned `server/package-contract.mjs`.
 * Returns `{status:'pending'}` when the module is absent — never a pass.
 */
export async function runContractTests(sourceRoot, docs, io = console) {
  const mod = resolveContractModule(sourceRoot);
  if (!mod.exists) {
    io.log(`  contract tests: PENDING — ${mod.path} does not exist yet (root/coordinator-owned).`);
    io.log('  PENDING is not a pass: validatePackage/canonicalJson/packageHash are unexercised here.');
    return { status: 'pending', modulePath: mod.path };
  }
  let m;
  try {
    m = await import(pathToFileURL(mod.path).href);
  } catch (e) {
    io.error(`  contract tests: FAILED to import ${mod.path}: ${e.message}`);
    return { status: 'failed', modulePath: mod.path, failed: 1 };
  }
  const missing = CONTRACT_EXPORTS.filter((n) => typeof m[n] !== 'function');
  if (missing.length) {
    io.error(`  contract tests: FAILED ${mod.path} does not export ${missing.join(', ')}`);
    return { status: 'failed', modulePath: mod.path, failed: missing.length };
  }
  io.log(`  contract tests: ${mod.path}${mod.fromEnv ? ` (from ${CONTRACT_MODULE_ENV})` : ''}`);
  let failed = 0;
  for (const name of CONTRACT_CASE_NAMES) {
    const c = contractCase(name, docs);
    let rejected = false;
    let detail = '';
    try {
      m.validatePackage(c.doc);
    } catch (e) {
      rejected = true;
      detail = e.code === 'invalid_package' ? '' : ` (error.code was ${JSON.stringify(e.code)}, expected "invalid_package")`;
      if (e.code !== 'invalid_package') { rejected = false; detail = `threw without code "invalid_package"`; }
    }
    const ok = c.expect === 'accept' ? !rejected : rejected;
    if (!ok) failed += 1;
    io.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name} -> ${rejected ? 'rejected' : 'accepted'}${ok ? '' : detail}`);
  }
  /* non-destructive deterministic canonical hash */
  {
    const doc = clone(docs.manifest);
    const before = JSON.stringify(doc);
    const h1 = m.packageHash(doc);
    const h2 = m.packageHash(doc);
    const c1 = m.canonicalJson(doc);
    const c2 = m.canonicalJson(doc);
    const unchanged = JSON.stringify(doc) === before;
    const shuffled = clone(docs.manifest);
    shuffled.forms[0].members = [...shuffled.forms[0].members].reverse();
    shuffled.exam = { levelModel: shuffled.exam.levelModel, language: shuffled.exam.language, title: shuffled.exam.title, id: shuffled.exam.id };
    const h3 = m.packageHash(shuffled);
    const ok = h1 === h2 && c1 === c2 && unchanged && typeof h1 === 'string' && h1 === h3;
    if (!ok) failed += 1;
    io.log(`    ${ok ? 'ok  ' : 'FAIL'} non-destructive deterministic canonical hash${ok ? '' : ` (${JSON.stringify({ h1, h2, h3, unchanged, canonicalEqual: c1 === c2 })})`}`);
  }
  return { status: failed === 0 ? 'passed' : 'failed', modulePath: mod.path, failed };
}

/* -------------------------------------------------------------------- CLI */
export async function runCli(argv = process.argv.slice(2), io = console) {
  const sourceRootArg = (() => {
    const i = argv.findIndex((a) => a === '--source-root');
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith('--source-root='));
    return eq ? eq.slice('--source-root='.length) : null;
  })();
  const sourceRoot = sourceRootArg ? path.resolve(sourceRootArg) : DEFAULT_SOURCE_ROOT;
  const selfTest = argv.includes('--self-test');
  const requireContract = argv.includes('--require-contract');

  if (sourceRootArg && !fs.existsSync(sourceRoot)) {
    io.error(`exam-s2-package-check: --source-root ${sourceRoot} does not exist`);
    return 2;
  }

  const docs = {};
  const loaded = [];
  let missingFile = 0;
  for (const d of DOCUMENTS) {
    const abs = path.join(sourceRoot, d.file);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      io.error(`exam-s2-package-check: cannot read ${abs}: ${e.message.split('\n')[0]}`);
      missingFile += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      io.error(`exam-s2-package-check: ${abs} is not valid JSON: ${e.message.split('\n')[0]}`);
      missingFile += 1;
      continue;
    }
    loaded.push({ ...d, abs, parsed });
    docs[d.label] = parsed;
  }

  io.log(`exam-s2-package-check: source-root ${sourceRoot}`);
  let failed = missingFile;
  let warnings = 0;
  for (const d of loaded) {
    const r = checkPackageShape(d.parsed, { label: d.label, kind: d.kind });
    const s = r.summary;
    io.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${d.label} (${path.relative(sourceRoot, d.abs)})`);
    io.log(`         exam=${s.examId} language=${d.parsed.exam?.language} levelModel=${d.parsed.exam?.levelModel?.type} state=${s.state} sections=${s.sections} parts=${s.parts} forms=${s.forms} sets=${s.sets}`);
    for (const w of r.warnings) { warnings += 1; io.log(`         WARN  ${w}`); }
    for (const e of r.errors) io.error(`         ERROR ${e}`);
    if (!r.ok) failed += 1;
  }

  let contract = { status: 'skipped' };
  if (loaded.length === 3) {
    const maps = { 'telc manifest': 'manifest', 'dtz-internal fixture': 'dtz', 'english-scale fixture': 'english' };
    const named = {};
    for (const [label, key] of Object.entries(maps)) named[key] = docs[label];
    if (selfTest) {
      const st = runLocalSelfTest(named, io);
      if (!st.ok) failed += 1;
    }
    contract = await runContractTests(sourceRoot, named, io);
  }

  if (contract.status === 'failed') failed += 1;
  if (contract.status === 'pending' && requireContract) failed += 1;
  if (failed === 0) {
    io.log('  OK    structural checks passed. This does not validate existing DB references,');
    io.log('        and it does not grant educational approval or learner availability.');
    if (contract.status === 'pending') io.log(`  PENDING contract tests (${contract.modulePath}); NOT claimed as passed.`);
    return 0;
  }
  io.error(`  FAIL  ${failed} failing check(s).`);
  return 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}

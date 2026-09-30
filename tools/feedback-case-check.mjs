/**
 * Structural checker for the synthetic writing-feedback case fixtures.
 *
 * Scope (USER-03 Task 3): this verifies fixture *integrity* only — schema shape, unique
 * and stable case IDs, synthetic labelling, vocabulary membership for expected
 * invariants and error classifications, required scenario coverage, and a few internal
 * consistency rules derived from the pilot contract.
 *
 * It does NOT and cannot verify that any invariant is actually satisfied by real
 * feedback, and it makes no linguistic, examiner or calibration judgement. Cases marked
 * `human-judgement-required` are reported separately because a machine cannot decide
 * whether a proposed correction is right for the learner's text.
 *
 * Dependency-free. Usage:
 *   node tools/feedback-case-check.mjs [path-to-fixture.json]
 * Exit code 0 when structurally sound, 1 on any error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_PATH = path.join(HERE, '..', 'tests', 'fixtures', 'writing-feedback-cases.json');

export const EXPECTED_VERSION = '0.1.0-draft';
export const MIN_CASES = 12;
const ID_PATTERN = /^WFC-[0-9]{2}$/;
const ALLOWED_JUDGEMENT = ['structural', 'human-judgement-required'];
const ALLOWED_OUTCOMES = ['assessed', 'unassessed', 'recoverable-failure', 'rejected-or-flagged'];
const SYNTHETIC_TEXT_PATTERN = /Hallo|Sehr geehrte|Guten Tag|vielen Dank|Ich /;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;

/**
 * Pure validator. No I/O, no globals.
 * @param {unknown} fixture parsed fixture object
 * @returns {{ok: boolean, errors: string[], warnings: string[], summary: object, humanJudgementCases: string[]}}
 */
export function validateFeedbackCases(fixture) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push(`[${code}] ${detail}`);
  const warn = (code, detail) => warnings.push(`[${code}] ${detail}`);
  const humanJudgementCases = [];
  const summary = { cases: 0, scenarios: 0, invariantsUsed: 0, structural: 0, humanJudgement: 0 };

  if (!isPlainObject(fixture)) {
    err('schema.root', 'fixture must be a JSON object');
    return { ok: false, errors, warnings, summary, humanJudgementCases };
  }

  /* ------------------------------------------------------ fixture-level */
  if (fixture.version !== EXPECTED_VERSION) {
    err('version', `version must be "${EXPECTED_VERSION}", got ${JSON.stringify(fixture.version)}`);
  }
  if (fixture.synthetic !== true) {
    err('synthetic.flag', 'synthetic must be true: these fixtures may not contain real learner work');
  }
  if (fixture.learnerDataIncluded !== false) {
    err('synthetic.learner-data', 'learnerDataIncluded must be false');
  }
  if (fixture.calibratedScoresIncluded !== false) {
    err('scores.calibrated', 'calibratedScoresIncluded must be false: no calibrated scores may be encoded here');
  }
  if (fixture.providerSchemaFrozen !== false) {
    err('schema.frozen', 'providerSchemaFrozen must be false: a production provider schema must not be frozen by this artifact');
  }

  if (!Array.isArray(fixture.invariantVocabulary) || fixture.invariantVocabulary.length === 0) {
    err('vocabulary.invariants', 'invariantVocabulary must be a non-empty array');
  }
  const invariantVocab = new Set(Array.isArray(fixture.invariantVocabulary) ? fixture.invariantVocabulary : []);

  if (!Array.isArray(fixture.errorClassifications) || fixture.errorClassifications.length === 0) {
    err('vocabulary.errors', 'errorClassifications must be a non-empty array');
  }
  const errorVocab = new Set(Array.isArray(fixture.errorClassifications) ? fixture.errorClassifications : []);

  if (!Array.isArray(fixture.requiredScenarios) || fixture.requiredScenarios.length === 0) {
    err('vocabulary.scenarios', 'requiredScenarios must be a non-empty array');
  }
  const requiredScenarios = Array.isArray(fixture.requiredScenarios) ? fixture.requiredScenarios : [];

  if (!Array.isArray(fixture.evidenceBase) || fixture.evidenceBase.length === 0) {
    err('evidence.missing', 'evidenceBase must record where the expectations come from');
  } else {
    fixture.evidenceBase.forEach((e, i) => {
      if (!isPlainObject(e)) return err('evidence.type', `evidenceBase[${i}] must be an object`);
      if (!isNonEmptyString(e.ref)) err('evidence.ref', `evidenceBase[${i}].ref is required`);
      if (!isNonEmptyString(e.path)) err('evidence.path', `evidenceBase[${i}].path is required`);
      if (!isNonEmptyString(e.note)) err('evidence.note', `evidenceBase[${i}].note is required`);
    });
  }

  /* ------------------------------------------------------------- cases */
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    err('cases.missing', 'cases must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings, summary, humanJudgementCases };
  }
  if (fixture.cases.length < MIN_CASES) {
    err('cases.minimum', `at least ${MIN_CASES} cases are required, found ${fixture.cases.length}`);
  }

  const seenIds = new Set();
  const seenScenarios = new Set();
  const invariantsUsed = new Set();

  fixture.cases.forEach((c, ci) => {
    const at = `cases[${ci}]`;
    if (!isPlainObject(c)) return err('case.type', `${at} must be an object`);
    const label = isNonEmptyString(c.id) ? c.id : at;

    /* stable case ID */
    if (!isNonEmptyString(c.id)) {
      err('case.id', `${at}.id is required`);
    } else if (!ID_PATTERN.test(c.id)) {
      err('case.id-format', `${at}.id "${c.id}" must match WFC-NN for a stable identifier`);
    } else if (seenIds.has(c.id)) {
      err('case.duplicate-id', `case id "${c.id}" is used more than once; case IDs must be unique and stable`);
    } else {
      seenIds.add(c.id);
    }

    /* synthetic labelling */
    if (c.synthetic !== true) {
      err('case.synthetic', `${label}.synthetic must be true`);
    }

    /* scenario coverage */
    if (!isNonEmptyString(c.scenario)) {
      err('case.scenario', `${label}.scenario is required`);
    } else {
      if (!requiredScenarios.includes(c.scenario)) {
        err('case.scenario-undeclared', `${label}.scenario "${c.scenario}" is not listed in requiredScenarios`);
      }
      seenScenarios.add(c.scenario);
    }

    /* provenance and rationale */
    if (!isNonEmptyString(c.source)) err('case.source', `${label}.source is required (evidence provenance)`);
    if (!isNonEmptyString(c.rationale)) err('case.rationale', `${label}.rationale is required`);
    if (!isNonEmptyString(c.title)) err('case.title', `${label}.title is required`);

    /* input */
    if (!isPlainObject(c.input)) {
      err('case.input', `${label}.input is required`);
    } else {
      if (!isNonEmptyString(c.input.kind)) {
        err('case.input-kind', `${label}.input.kind is required`);
      }
      const text = c.input.learnerText;
      const sample = c.input.malformedSample;
      if (!isNonEmptyString(text) && !isNonEmptyString(sample) && !isNonEmptyString(c.input.note)) {
        err('case.input-payload', `${label}.input needs learnerText, malformedSample or an explanatory note`);
      }
      if (isNonEmptyString(text) && !SYNTHETIC_TEXT_PATTERN.test(text)) {
        warn('case.input-unlabelled', `${label}.input.learnerText does not look like an obviously synthetic German sample`);
      }
      if (isNonEmptyString(text) && /@|\+49|\b\d{6,}\b/.test(text)) {
        warn('case.input-pii-shape', `${label}.input.learnerText contains an e-mail/phone/long-number shape; confirm it is fabricated`);
      }
    }

    if (!isPlainObject(c.provider) || !isNonEmptyString(c.provider.behaviour)) {
      err('case.provider', `${label}.provider.behaviour is required`);
    }

    /* expectations */
    const exp = c.expected;
    if (!isPlainObject(exp)) {
      err('case.expected', `${label}.expected is required`);
      return;
    }
    if (!isNonEmptyString(exp.outcome)) {
      err('case.outcome', `${label}.expected.outcome is required`);
    } else if (!ALLOWED_OUTCOMES.includes(exp.outcome)) {
      err('case.outcome-unknown', `${label}.expected.outcome "${exp.outcome}" is not one of ${ALLOWED_OUTCOMES.join(', ')}`);
    }

    if (!isNonEmptyString(exp.errorClassification)) {
      err('case.error', `${label}.expected.errorClassification is required`);
    } else if (!errorVocab.has(exp.errorClassification)) {
      err('case.error-unknown', `${label}.expected.errorClassification "${exp.errorClassification}" is not in errorClassifications`);
    }

    if (!Array.isArray(exp.invariants) || exp.invariants.length === 0) {
      err('case.invariants', `${label}.expected.invariants must be a non-empty array`);
    } else {
      for (const inv of exp.invariants) {
        if (!isNonEmptyString(inv)) {
          err('case.invariant-type', `${label}.expected.invariants contains a non-string entry`);
          continue;
        }
        if (!invariantVocab.has(inv)) {
          err('case.invariant-unknown', `${label}.expected.invariants references undeclared invariant "${inv}"`);
        }
        invariantsUsed.add(inv);
      }
    }

    /* never permit a numeric score in this artifact */
    if (exp.numericScorePermitted !== false) {
      err('case.numeric-score', `${label}.expected.numericScorePermitted must be false: no calibrated numeric score may be expected here`);
    }

    /* error-classification coherence with the contract's retry semantics */
    if (exp.errorClassification === 'retry_exhausted' && exp.retryPermitted === true) {
      err('case.retry-coherence', `${label}: retry_exhausted must never permit another retry`);
    }
    if (exp.errorClassification === 'provider_unavailable' && exp.retryPermitted !== true) {
      err('case.retry-coherence', `${label}: provider_unavailable is a bounded-retry classification, so retryPermitted must be true`);
    }
    if (exp.errorClassification === 'malformed_feedback' && exp.outcome === 'assessed') {
      err('case.malformed-outcome', `${label}: malformed feedback must not yield an assessed outcome`);
    }
    if (exp.outcome === 'unassessed' && exp.assessmentCreated === true) {
      err('case.unassessed-assessment', `${label}: an unassessed outcome must not create an assessment`);
    }
    if (exp.usageDebited === true && exp.assessmentCreated === false) {
      err('case.debit-without-assessment', `${label}: usage must not be debited without a completed assessment`);
    }

    /* register/role coherence, the recorded failure mode */
    if (exp.wrongSituation === true && exp.contentScoreCreditPreserved === true) {
      err('case.register-coherence', `${label}: a wrong situation withdraws content credit, so contentScoreCreditPreserved must not be true`);
    }
    if (exp.wrongSituation === true && exp.invariants && exp.invariants.includes('register-not-conflated-with-role') === false) {
      warn('case.register-invariant', `${label} asserts a wrong situation without the register/role invariant; confirm that is intended`);
    }
    if (exp.wrongSituation === false && exp.contentScoreCreditPreserved === false) {
      err('case.register-coherence', `${label}: content credit may only be withdrawn for a genuine wrong situation`);
    }

    /* judgement class */
    if (!isNonEmptyString(c.judgement)) {
      err('case.judgement', `${label}.judgement is required`);
    } else if (!ALLOWED_JUDGEMENT.includes(c.judgement)) {
      err('case.judgement-unknown', `${label}.judgement "${c.judgement}" is not one of ${ALLOWED_JUDGEMENT.join(', ')}`);
    } else if (c.judgement === 'human-judgement-required') {
      humanJudgementCases.push(c.id);
      summary.humanJudgement += 1;
    } else {
      summary.structural += 1;
    }
  });

  /* ----------------------------------------------------- coverage checks */
  for (const scenario of requiredScenarios) {
    if (!seenScenarios.has(scenario)) {
      err('coverage.missing-scenario', `required scenario "${scenario}" has no case`);
    }
  }
  for (const scenario of seenScenarios) {
    const count = fixture.cases.filter((c) => c.scenario === scenario).length;
    if (count > 1) {
      warn('coverage.duplicate-scenario', `scenario "${scenario}" has ${count} cases`);
    }
  }
  const unusedInvariants = [...invariantVocab].filter((i) => !invariantsUsed.has(i));
  if (unusedInvariants.length) {
    warn('coverage.unused-invariant', `declared invariants not asserted by any case: ${unusedInvariants.join(', ')}`);
  }
  if (humanJudgementCases.length === 0) {
    warn('coverage.judgement', 'no case is marked human-judgement-required; some expectations cannot be machine-checked');
  }

  summary.cases = fixture.cases.length;
  summary.scenarios = seenScenarios.size;
  summary.invariantsUsed = invariantsUsed.size;

  return { ok: errors.length === 0, errors, warnings, summary, humanJudgementCases };
}

/* -------------------------------------------------------------------- CLI */
export function runCli(argv = process.argv.slice(2), io = console) {
  const target = argv.find((a) => !a.startsWith('-')) || DEFAULT_FIXTURE_PATH;
  const abs = path.resolve(target);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    io.error(`Cannot read feedback fixtures: ${abs}\n  ${e.message}`);
    return 1;
  }
  const r = validateFeedbackCases(parsed);
  io.log(`feedback-case-check: ${abs}`);
  io.log(`  cases=${r.summary.cases} scenarios=${r.summary.scenarios}/${(parsed.requiredScenarios || []).length} invariantsUsed=${r.summary.invariantsUsed} structural=${r.summary.structural} humanJudgement=${r.summary.humanJudgement}`);
  for (const w of r.warnings) io.log(`  WARN  ${w}`);
  for (const e of r.errors) io.error(`  ERROR ${e}`);
  if (r.humanJudgementCases.length) {
    io.log(`  HUMAN ${r.humanJudgementCases.join(', ')} cannot be decided by a machine; route to C-05 human review.`);
  }
  if (r.ok) {
    io.log(`  OK    fixtures are structurally sound (${r.warnings.length} warning(s)).`);
    io.log('  NOTE  structural integrity is not linguistic correctness and not examiner calibration.');
    return 0;
  }
  io.error(`  FAIL  ${r.errors.length} error(s).`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(runCli());
}

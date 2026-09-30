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
/**
 * structural                 — every expected invariant is mechanically decidable
 * mixed                      — some invariants are mechanical, others need a human
 * human-judgement-required   — nothing about this case is mechanically decidable
 */
const ALLOWED_JUDGEMENT = ['structural', 'mixed', 'human-judgement-required'];
/**
 * Whether the expected invariant can be decided mechanically from shape/state, or needs a
 * human. A validator can check that feedback was produced, saved once, quoted and not
 * invented; it cannot decide content coverage, register, relevance or linguistic correctness.
 */
export const ALLOWED_DECIDABILITY = ['mechanical', 'linguistic-human'];
const ALLOWED_OUTCOMES = ['assessed', 'unassessed', 'recoverable-failure', 'rejected-or-flagged'];
const SYNTHETIC_TEXT_PATTERN = /Hallo|Sehr geehrte|Guten Tag|vielen Dank|Ich /;
/** Error codes whose retryability is conditional on state rather than fixed by the code. */
export const CONDITIONAL_RETRY_ERRORS = ['provider_unavailable', 'malformed_feedback'];

/** Classifications that never retry, whatever state the attempt is in. */
export const TERMINAL_ERRORS = ['retry_exhausted', 'attempt_deleted', 'stale_lease'];

/**
 * Classifications that are ineligible *now* rather than permanently failed. The current
 * contract does not establish these as terminal domain policies, so a later renewal or
 * revision may make the action possible again. Cases must not assert permanence.
 */
export const INELIGIBLE_ERRORS = ['allowance_exhausted', 'submission_superseded'];

/** State conditions a conditional retry must satisfy. */
export const RETRY_CONDITIONS = [
  'claimsRemaining', 'entitlementActive', 'attemptNotDeleted', 'liveLease', 'assessmentNotAlreadySaved',
];

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
  const mixedCases = [];
  const summary = { cases: 0, scenarios: 0, invariantsUsed: 0, structural: 0, mixed: 0, humanJudgement: 0, mechanicalInvariants: 0, humanInvariants: 0 };

  if (!isPlainObject(fixture)) {
    err('schema.root', 'fixture must be a JSON object');
    return { ok: false, errors, warnings, summary, humanJudgementCases, mixedCases };
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

  // The fixture's classificationSemantics must agree with this checker's own constants,
  // otherwise the declared policy can drift from the enforced one.
  if (!isPlainObject(fixture.classificationSemantics)) {
    err('semantics.missing', 'classificationSemantics is required so the declared policy cannot drift from the enforced one');
  } else {
    const sem = fixture.classificationSemantics;
    const expectedPairs = [
      ['permanentFailure', TERMINAL_ERRORS],
      ['currentlyIneligible', INELIGIBLE_ERRORS],
    ];
    for (const [key, enforced] of expectedPairs) {
      if (!Array.isArray(sem[key])) {
        err('semantics.type', `classificationSemantics.${key} must be an array`);
        continue;
      }
      const declared = [...sem[key]].sort();
      const actual = [...enforced].sort();
      if (declared.join(',') !== actual.join(',')) {
        err('semantics.drift', `classificationSemantics.${key} is [${declared.join(', ')}] but the checker enforces [${actual.join(', ')}]`);
      }
    }
    if (!isNonEmptyString(sem.note)) {
      err('semantics.note', 'classificationSemantics.note is required to explain that ineligibility is not permanence');
    }
  }

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
    return { ok: errors.length === 0, errors, warnings, summary, humanJudgementCases, mixedCases };
  }
  if (fixture.cases.length < MIN_CASES) {
    err('cases.minimum', `at least ${MIN_CASES} cases are required, found ${fixture.cases.length}`);
  }

  const seenIds = new Set();
  const seenScenarios = new Set();
  const invariantsUsed = new Set();

  fixture.cases.forEach((c, ci) => {
    const at = `cases[${ci}]`;
    if (!isPlainObject(c)) {
      // A null or primitive entry must be reported, never dereferenced.
      err('case.type', `${at} must be an object`);
      return;
    }
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

    /* error-classification coherence with the contract's conditional retry semantics */
    if (exp.errorClassification === 'retry_exhausted' && exp.retryPermitted === true) {
      err('case.retry-coherence', `${label}: retry_exhausted must never permit another retry`);
    }
    // Retryability is conditional on state. A provider-unavailable or malformed-feedback
    // failure may only be retried while a claim remains, the entitlement is active, the
    // attempt is not deleted and no authoritative assessment is already saved.
    if (CONDITIONAL_RETRY_ERRORS.includes(exp.errorClassification)) {
      const conditions = Array.isArray(exp.retryConditions) ? exp.retryConditions : [];
      if (exp.retryPermitted === true && conditions.length === 0) {
        err('case.retry-conditions', `${label}: ${exp.errorClassification} is retryable only under explicit state conditions, so retryConditions must be stated`);
      }
      if (exp.retryPermitted !== true && conditions.length > 0) {
        err('case.retry-conditions', `${label}: retryConditions are stated but retryPermitted is not true`);
      }
      for (const cond of conditions) {
        if (!RETRY_CONDITIONS.includes(cond)) {
          err('case.retry-condition-unknown', `${label}.retryConditions names "${cond}", which is not a known state condition`);
        }
      }
      if (exp.retryPermitted === true && conditions.length > 0) {
        warn('case.retry-conditional', `${label}: retry is permitted only while ${conditions.join(', ')} hold`);
      }
    } else if (TERMINAL_ERRORS.includes(exp.errorClassification)) {
      // A terminal classification never retries, and must not advertise state conditions.
      if (exp.retryPermitted === true) {
        err('case.retry-coherence', `${label}: ${exp.errorClassification} is a terminal classification and must not permit a retry`);
      }
      if (Array.isArray(exp.retryConditions) && exp.retryConditions.length > 0) {
        err('case.retry-conditions-terminal', `${label}: ${exp.errorClassification} never retries, so it must not list retryConditions`);
      }
      if (exp.permanentlyTerminal !== true) {
        err('case.terminal-flag', `${label}: ${exp.errorClassification} is a permanent failure, so permanentlyTerminal must be set true (a terminal case may not merely omit the flag)`);
      }
      if (exp.permanentlyTerminal === false) {
        err('case.terminal-contradiction', `${label}: ${exp.errorClassification} is a permanent failure, so permanentlyTerminal may not be false`);
      }
    } else if (INELIGIBLE_ERRORS.includes(exp.errorClassification)) {
      // Ineligible now, not permanently failed. The contract does not establish permanence.
      if (exp.retryPermitted === true) {
        err('case.retry-coherence', `${label}: ${exp.errorClassification} is not currently eligible for a retry`);
      }
      if (Array.isArray(exp.retryConditions) && exp.retryConditions.length > 0) {
        err('case.retry-conditions-terminal', `${label}: ${exp.errorClassification} must not list retryConditions while ineligible`);
      }
      if (exp.permanentlyTerminal === true) {
        err('case.ineligibility-permanence', `${label}: ${exp.errorClassification} must not be asserted as a permanently terminal failure; the contract establishes only current ineligibility`);
      }
      if (exp.currentlyIneligible !== true) {
        err('case.ineligibility-flag', `${label}: ${exp.errorClassification} must set currentlyIneligible true to distinguish present ineligibility from permanent failure`);
      }
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
    // Content credit may also be withdrawn WITHOUT a wrong situation, in two legitimate ways:
    // (a) topic-missed — no connection to the task, so criterion I is D and the language criteria
    //     are zeroed as well; (b) a Leitpunkt shortfall — only one or no Leitpunkt is handled, so
    //     criterion I is D while the language criteria remain assessable.
    // A shortfall of one or two missing points is NOT automatic zero credit: the case must state
    // how many points were handled, and only 0 or 1 justifies withdrawing credit.
    const topicMissed = exp.topicMissed === true;
    const expectedCredit = exp.contentScoreCreditPreserved;
    const stated = c.leitpunktShortfall === true || (isPlainObject(c.input) && c.input.leitpunktShortfall === true);
    if (topicMissed && stated) {
      err('case.topic-missed-conflated', `${label}: topic-missed and a Leitpunkt shortfall are different branches; declare only one`);
    }

    // How many of the four points the synthetic text actually handles, when declared.
    const pointsHandled = Number.isInteger(c.pointsHandled) ? c.pointsHandled : null;
    if (c.pointsHandled !== undefined && c.pointsHandled !== null && !Number.isInteger(c.pointsHandled)) {
      err('case.points-handled-type', `${label}.pointsHandled must be an integer between 0 and 4`);
    } else if (pointsHandled !== null && (pointsHandled < 0 || pointsHandled > 4)) {
      err('case.points-handled-range', `${label}.pointsHandled must be between 0 and 4, got ${pointsHandled}`);
    }

    const creditWithdrawn = expectedCredit === false;
    // A genuine wrong situation is its own, already-validated explanation for the withdrawal.
    const shortfallExplainsCredit = stated || pointsHandled === 0 || pointsHandled === 1 || exp.wrongSituation === true;
    if (creditWithdrawn && !shortfallExplainsCredit && !topicMissed) {
      err('case.content-credit-unexplained', `${label}: content credit is withdrawn without a wrong situation, so either topic-missed or a Leitpunkt shortfall of 0-1 handled points must be stated`);
    }
    if (stated && !creditWithdrawn) {
      err('case.leitpunkt-credit', `${label}: a Leitpunkt shortfall that withdraws credit must set contentScoreCreditPreserved false`);
    }
    if (stated && exp.wrongSituation === true) {
      err('case.leitpunkt-wrong-situation', `${label}: a Leitpunkt shortfall and a wrong situation are different cases; do not merge them`);
    }
    if (topicMissed && expectedCredit !== false && expectedCredit !== undefined) {
      err('case.topic-missed-credit', `${label}: a topic-missed text cannot retain content credit`);
    }
    if (topicMissed && exp.languageCriteriaStillAssessed === true) {
      err('case.topic-missed-language', `${label}: topic-missed sets the language criteria to zero, so languageCriteriaStillAssessed must not be true`);
    }
    // Criterion I is D only for one or no handled point; three of four preserves credit.
    if (pointsHandled !== null) {
      if (pointsHandled >= 2 && creditWithdrawn) {
        err('case.credit-withdrawn-too-early', `${label}: ${pointsHandled} of 4 points handled is not the criterion-I-zero branch, so content credit must be preserved`);
      }
      if (pointsHandled <= 1 && !creditWithdrawn && !topicMissed) {
        err('case.credit-kept-below-threshold', `${label}: only ${pointsHandled} of 4 points handled, so criterion I is D and content credit must be withdrawn`);
      }
    }
    if (exp.wrongSituation === true && exp.invariants && exp.invariants.includes('register-not-conflated-with-role') === false) {
      warn('case.register-invariant', `${label} asserts a wrong situation without the register/role invariant; confirm that is intended`);
    }

    /* judgement class */
    if (!isNonEmptyString(c.judgement)) {
      err('case.judgement', `${label}.judgement is required`);
    } else if (!ALLOWED_JUDGEMENT.includes(c.judgement)) {
      err('case.judgement-unknown', `${label}.judgement "${c.judgement}" is not one of ${ALLOWED_JUDGEMENT.join(', ')}`);
    } else if (c.judgement === 'human-judgement-required') {
      humanJudgementCases.push(c.id);
      summary.humanJudgement += 1;
    } else if (c.judgement === 'mixed') {
      mixedCases.push(c.id);
      summary.mixed += 1;
    } else {
      summary.structural += 1;
    }

    /* decidability: which invariants a machine may decide, and which need a human */
    if (!isPlainObject(c.decidability)) {
      err('case.decidability', `${label}.decidability is required so mechanical checks are not confused with judgement`);
    } else {
      const { mechanical, linguisticHuman } = c.decidability;
      if (!Array.isArray(mechanical)) {
        err('case.decidability-mechanical', `${label}.decidability.mechanical must be an array (use [] when nothing is mechanical)`);
      }
      if (!Array.isArray(linguisticHuman)) {
        err('case.decidability-linguistic', `${label}.decidability.linguisticHuman must be an array (use [] when nothing needs a human)`);
      }
      if (Array.isArray(mechanical) && Array.isArray(linguisticHuman) && mechanical.length === 0 && linguisticHuman.length === 0) {
        err('case.decidability-empty', `${label}.decidability classifies no invariant at all`);
      }
      for (const key of ['mechanical', 'linguisticHuman']) {
        const list = c.decidability[key];
        if (!Array.isArray(list)) continue;
        for (const inv of list) {
          if (!isNonEmptyString(inv)) {
            err('case.decidability-type', `${label}.decidability.${key} contains a non-string entry`);
          } else if (!invariantVocab.has(inv)) {
            err('case.decidability-unknown', `${label}.decidability.${key} references undeclared invariant "${inv}"`);
          } else if (Array.isArray(exp.invariants) && !exp.invariants.includes(inv)) {
            err('case.decidability-not-expected', `${label}.decidability.${key} names "${inv}", which the case does not expect`);
          }
        }
      }
      if (Array.isArray(mechanical) && Array.isArray(linguisticHuman)) {
        const both = mechanical.filter((m) => linguisticHuman.includes(m));
        if (both.length) {
          err('case.decidability-overlap', `${label}: ${both.join(', ')} cannot be both mechanically and humanly decided`);
        }
        const covered = [...mechanical, ...linguisticHuman];
        if (Array.isArray(exp.invariants)) {
          const uncovered = exp.invariants.filter((i) => !covered.includes(i));
          if (uncovered.length) {
            err('case.decidability-gap', `${label}: ${uncovered.join(', ')} are neither mechanical nor human-classified`);
          }
        }
      }
      // A case that needs a linguistic verdict must say so in its judgement class.
      if (Array.isArray(linguisticHuman) && linguisticHuman.length > 0 && c.judgement === 'structural') {
        const purelyMechanical = Array.isArray(mechanical) && mechanical.length === 0;
        if (purelyMechanical) {
          err('case.judgement-mismatch', `${label} claims to be structural but classifies every invariant as human judgement`);
        }
      }
      summary.mechanicalInvariants += Array.isArray(mechanical) ? mechanical.length : 0;
      summary.humanInvariants += Array.isArray(linguisticHuman) ? linguisticHuman.length : 0;
    }
  });

  /* ----------------------------------------------------- coverage checks */
  for (const scenario of requiredScenarios) {
    if (!seenScenarios.has(scenario)) {
      err('coverage.missing-scenario', `required scenario "${scenario}" has no case`);
    }
  }
  for (const scenario of seenScenarios) {
    const count = fixture.cases.filter((c) => isPlainObject(c) && c.scenario === scenario).length;
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

  return { ok: errors.length === 0, errors, warnings, summary, humanJudgementCases, mixedCases };
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
  io.log(`  cases=${r.summary.cases} scenarios=${r.summary.scenarios}/${(parsed.requiredScenarios || []).length} invariantsUsed=${r.summary.invariantsUsed} structural=${r.summary.structural} mixed=${r.summary.mixed} humanJudgement=${r.summary.humanJudgement}`);
  io.log(`  invariants: mechanically decidable=${r.summary.mechanicalInvariants} human-judgement=${r.summary.humanInvariants}`);
  io.log('  BOUNDARY A machine may check shape, state and evidence presence. It cannot decide content');
  io.log('  BOUNDARY coverage, register, relevance or linguistic correctness; those stay human review.');
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

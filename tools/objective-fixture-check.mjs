/**
 * Structural validator for the synthetic objective-marking fixtures.
 *
 * Scope (USER-04 Task 3): this defines and checks the *shape* of future objective marking —
 * which key type each part family uses, which answers are legal tokens, how blanks differ
 * from a supported no-match, what a duplicate matching selection means, and that item weights
 * aggregate to the verified subtest maxima.
 *
 * It does NOT mark learner work, does NOT implement authoritative scoring, and does NOT decide
 * pass/fail. It also cannot judge whether an item or answer key is educationally sound; that is
 * content review (C-03/E-01) and human judgement.
 *
 * Dependency-free. Usage:
 *   node tools/objective-fixture-check.mjs [path-to-fixture.json]
 * Exit code 0 when structurally sound, 1 on any error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_PATH = path.join(HERE, '..', 'tests', 'fixtures', 'objective-marking-cases.json');

export const EXPECTED_VERSION = '0.1.0-draft';
export const REQUIRED_FAMILIES = ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3'];

const ID_PATTERN = /^OMC-[A-Z0-9]+-[0-9]{2}$/;
const ALLOWED_KEY_TYPES = ['matching-single-use', 'mc-choice', 'mc-choice-inline', 'word-bank-single-use', 'true-false'];
const ALLOWED_SCENARIOS = [
  'all-correct', 'all-correct-with-no-match', 'all-wrong', 'blank', 'partial-weight-aggregation',
  'invalid-choice', 'duplicate-matching-selection', 'unsupported-no-match',
  'no-match-marked-where-not-expected', 'duplicate-bank-word', 'family-weight-aggregation',
  'item-count-continuity', 'writing-unassessed', 'provider-failure-no-heuristic',
];
/**
 * Outcome words that would assert a learner's overall examination result. The pilot cannot
 * compute one — the oral part is unassessed — so no objective fixture may claim it.
 */
const PROHIBITED_LEARNER_CLAIMS = [
  'passed', 'failed', 'pass', 'fail', 'bestanden', 'nicht bestanden', 'sehr gut', 'gut',
  'befriedigend', 'ausreichend', 'readiness', 'grade', 'band', 'overall', 'certificate',
];
/** Families that have no objective key of their own and are asserted separately. */
const NON_OBJECTIVE_FAMILIES = ['SA1'];
const ALLOWED_OUTCOMES = ['marked', 'marked-or-flagged', 'rejected-or-flagged', 'aggregate', 'unassessed'];
const ALLOWED_ERRORS = [
  'none', 'invalid-answer', 'duplicate-selection', 'no-match-not-supported',
  'provider_unavailable',
];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
const close = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * Pure validator. No I/O, no globals.
 * @param {unknown} fixture parsed fixture object
 * @returns {{ok:boolean, errors:string[], warnings:string[], summary:object, families:Map<string,object>}}
 */
export function validateObjectiveCases(fixture) {
  const errors = [];
  const warnings = [];
  const err = (c, d) => errors.push(`[${c}] ${d}`);
  const warn = (c, d) => warnings.push(`[${c}] ${d}`);
  const summary = { families: 0, cases: 0, objectiveItems: 0, objectivePoints: 0, scenarios: 0 };
  const families = new Map();

  if (!isPlainObject(fixture)) {
    err('schema.root', 'fixture must be a JSON object');
    return { ok: false, errors, warnings, summary, families };
  }

  /* ---------------------------------------------------------- metadata */
  if (fixture.version !== EXPECTED_VERSION) err('version', `version must be "${EXPECTED_VERSION}"`);
  if (fixture.synthetic !== true) err('synthetic.flag', 'synthetic must be true');
  if (fixture.reviewed !== false) err('reviewed.flag', 'reviewed must be false: these fixtures are unvalidated expectations');
  if (fixture.containsRealExamText !== false) {
    err('synthetic.real-text', 'containsRealExamText must be false: no real exam or seed text may be copied in');
  }
  if (!Array.isArray(fixture.keyTypes) || fixture.keyTypes.length === 0) {
    err('keyTypes.missing', 'keyTypes must be a non-empty array');
  } else {
    for (const kt of fixture.keyTypes) {
      if (!ALLOWED_KEY_TYPES.includes(kt)) err('keyTypes.unknown', `keyTypes contains unknown key type "${kt}"`);
    }
  }
  if (!isPlainObject(fixture.optionPools)) {
    err('optionPools.missing', 'optionPools object is required');
  }

  /* ----------------------------------------------------------- families */
  if (!Array.isArray(fixture.families) || fixture.families.length === 0) {
    err('families.missing', 'families must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings, summary, families };
  }

  let coveredItems = [];
  let objectivePoints = 0;

  fixture.families.forEach((fam, fi) => {
    const at = `families[${fi}]`;
    if (!isPlainObject(fam)) return err('family.type', `${at} must be an object`);
    const label = isNonEmptyString(fam.id) ? fam.id : at;

    if (!isNonEmptyString(fam.id)) err('family.id', `${at}.id is required`);
    else if (families.has(fam.id)) err('family.duplicate-id', `family "${fam.id}" is defined more than once`);
    else families.set(fam.id, fam);

    if (!isNonEmptyString(fam.subtest)) err('family.subtest', `${label}.subtest is required`);
    if (!ALLOWED_KEY_TYPES.includes(fam.keyType)) {
      err('family.key-type', `${label}.keyType "${fam.keyType}" is not a supported key type`);
    }
    if (!isNonEmptyString(fam.responseFormat)) err('family.response-format', `${label}.responseFormat is required`);
    if (!isPositiveInteger(fam.pointsMax)) err('family.points-max', `${label}.pointsMax must be a positive integer`);

    if (fam.reuseLimit !== null && fam.reuseLimit !== undefined && !isPositiveInteger(fam.reuseLimit)) {
      err('family.reuse-limit', `${label}.reuseLimit must be a positive integer or null`);
    }
    if (fam.noMatchSupported === true) {
      if (!isNonEmptyString(fam.noMatchMarker)) {
        err('family.no-match-marker', `${label} supports no-match but declares no noMatchMarker`);
      }
    } else if (fam.noMatchSupported !== false) {
      err('family.no-match-flag', `${label}.noMatchSupported must be a boolean`);
    }

    if (fam.permittedPlays !== undefined && fam.permittedPlays !== null) {
      if (!isPositiveInteger(fam.permittedPlays)) err('family.plays', `${label}.permittedPlays must be a positive integer`);
      else if (fam.permittedPlays > 2) err('family.plays-unsupported', `${label}.permittedPlays exceeds the verified maximum of two`);
    }

    /* key items */
    if (!Array.isArray(fam.items) || fam.items.length === 0) {
      err('family.items', `${label}.items must be a non-empty array`);
    } else {
      const pool = isPlainObject(fixture.optionPools) && isNonEmptyString(fam.optionPool)
        ? fixture.optionPools[fam.optionPool]
        : null;
      if (!Array.isArray(pool)) {
        err('family.option-pool', `${label}.optionPool "${fam.optionPool}" is not defined in optionPools`);
      }
      const seenN = new Set();
      const numbers = [];
      fam.items.forEach((it, ii) => {
        const iat = `${label}.items[${ii}]`;
        if (!isPlainObject(it)) return err('item.type', `${iat} must be an object`);
        if (!isPositiveInteger(it.n)) {
          err('item.number', `${iat}.n must be a positive integer`);
        } else {
          if (seenN.has(it.n)) err('item.duplicate-number', `${iat}.n ${it.n} is repeated in ${label}`);
          seenN.add(it.n);
          numbers.push(it.n);
        }
        if (!isNonEmptyString(it.key)) {
          err('item.key', `${iat}.key must be a non-empty string`);
        } else if (Array.isArray(pool)) {
          const legal = pool.includes(it.key) || (fam.noMatchSupported === true && it.key === fam.noMatchMarker);
          if (!legal) {
            err('item.key-outside-pool', `${iat}.key "${it.key}" is neither in pool "${fam.optionPool}" nor the no-match marker`);
          }
        }
      });
      if (numbers.length) {
        const sorted = [...numbers].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i] === sorted[i - 1]) continue;
          if (sorted[i] !== sorted[i - 1] + 1) {
            err('item.not-contiguous', `${label} item numbers are not contiguous at ${sorted[i - 1]} -> ${sorted[i]}`);
            break;
          }
        }
        coveredItems.push({ family: fam.id, first: sorted[0], last: sorted[sorted.length - 1], count: numbers.length });
      }
      // single-use families must not repeat a key. The no-match marker is the only
      // legitimate repeat, because several situations can have no matching option; the
      // whole point of the rule is that a real option is consumed by one item.
      if (isPositiveInteger(fam.reuseLimit) && fam.reuseLimit === 1) {
        const consumed = fam.items
          .filter((i) => isPlainObject(i))
          .map((i) => i.key)
          .filter((k) => isNonEmptyString(k) && !(fam.noMatchSupported === true && k === fam.noMatchMarker));
        const dupes = [...new Set(consumed.filter((k, i) => consumed.indexOf(k) !== i))];
        if (dupes.length) {
          err('family.key-reuse', `${label} declares reuseLimit 1 but repeats option key(s): ${dupes.join(', ')}${fam.noMatchSupported === true ? ` (the no-match marker "${fam.noMatchMarker}" is exempt)` : ''}`);
        }
      }
    }
    if (isPositiveInteger(fam.pointsMax)) objectivePoints += fam.pointsMax;
  });

  /* required family coverage */
  for (const id of REQUIRED_FAMILIES) {
    if (!families.has(id)) err('coverage.missing-family', `required family "${id}" has no definition`);
  }
  summary.families = families.size;

  /* item numbering across families must be 1..N without gaps */
  const sortedFams = [...coveredItems].sort((a, b) => a.first - b.first);
  let expected = 1;
  for (const f of sortedFams) {
    if (f.first !== expected) {
      err('coverage.item-gap', `items must be numbered 1..N across families; "${f.family}" starts at ${f.first} but ${expected} was expected`);
    }
    expected = f.last + 1;
  }
  summary.objectiveItems = expected - 1;
  summary.objectivePoints = objectivePoints;
  if (objectivePoints !== 180) {
    warn('coverage.objective-points', `objective family maxima sum to ${objectivePoints}; the verified objective subtotal is 180`);
  }

  /* -------------------------------------------------------------- cases */
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    err('cases.missing', 'cases must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings, summary, families };
  }
  const seenIds = new Set();
  const seenScenarios = new Set();

  fixture.cases.forEach((c, ci) => {
    const at = `cases[${ci}]`;
    if (!isPlainObject(c)) return err('case.type', `${at} must be an object`);
    const label = isNonEmptyString(c.id) ? c.id : at;

    if (!isNonEmptyString(c.id)) err('case.id', `${at}.id is required`);
    else if (!ID_PATTERN.test(c.id)) err('case.id-format', `${at}.id "${c.id}" must match OMC-<FAMILY>-NN`);
    else if (seenIds.has(c.id)) err('case.duplicate-id', `case id "${c.id}" is used more than once`);
    else seenIds.add(c.id);

    if (c.synthetic !== true) err('case.synthetic', `${label}.synthetic must be true`);

    if (!isNonEmptyString(c.family)) {
      err('case.family', `${label}.family is required`);
    } else if (c.family !== 'ALL' && !NON_OBJECTIVE_FAMILIES.includes(c.family) && !families.has(c.family)) {
      err('case.family-unknown', `${label}.family "${c.family}" is not a defined family`);
    }
    // Only the writing family may be asserted without an objective key.
    if (NON_OBJECTIVE_FAMILIES.includes(c.family) && c.unassessed !== true) {
      err('case.non-objective-assessed', `${label} belongs to ${c.family}, which has no objective key, so it must be marked unassessed`);
    }

    if (!isNonEmptyString(c.scenario)) {
      err('case.scenario', `${label}.scenario is required`);
    } else {
      if (!ALLOWED_SCENARIOS.includes(c.scenario)) {
        err('case.scenario-unknown', `${label}.scenario "${c.scenario}" is not a supported scenario`);
      }
      seenScenarios.add(c.scenario);
    }

    if (!isNonEmptyString(c.rationale)) err('case.rationale', `${label}.rationale is required`);

    if (!ALLOWED_OUTCOMES.includes(c.expectedOutcome)) {
      err('case.outcome', `${label}.expectedOutcome "${c.expectedOutcome}" is not supported`);
    }
    if (!ALLOWED_ERRORS.includes(c.expectedError)) {
      err('case.error', `${label}.expectedError "${c.expectedError}" is not supported`);
    }
    if (typeof c.unassessed !== 'boolean') err('case.unassessed', `${label}.unassessed must be a boolean`);

    /* A case that carries answers must belong to one concrete family. */
    const hasAnswers = c.answers !== null && c.answers !== undefined;
    if (hasAnswers && c.family === 'ALL') {
      err('case.aggregate-answers', `${label} is an aggregate case and must not carry per-item answers`);
    }
    // An aggregate or unassessed case has no per-item marking surface, so carrying a correct
    // count or a point total would assert a learner result the fixture cannot justify.
    const isAggregate = c.family === 'ALL' || c.expectedOutcome === 'aggregate';
    if (isAggregate) {
      for (const field of ['expectedCorrectCount', 'expectedPoints']) {
        if (c[field] !== null && c[field] !== undefined) {
          err('case.aggregate-learner-score', `${label}.${field} asserts a per-item learner result on an aggregate case; it must stay null`);
        }
      }
    }
    // A marked case must carry answers; null answers are only meaningful for aggregate or
    // unassessed cases, which is checked explicitly rather than left to inference.
    if (!hasAnswers && c.family !== 'ALL' && c.expectedOutcome !== 'unassessed'
        && (c.expectedOutcome === 'marked' || c.expectedOutcome === 'marked-or-flagged' || c.expectedOutcome === 'rejected-or-flagged')) {
      err('case.answers-required', `${label} is a ${c.expectedOutcome} case, so per-item answers are required`);
    }
    if (!hasAnswers && c.family !== 'ALL' && c.expectedOutcome !== 'unassessed') {
      warn('case.no-answers', `${label} has no answers but is not an aggregate or unassessed case`);
    }

    /* Answer keys and values must line up with the family definition. */
    const fam = families.get(c.family);
    if (hasAnswers && fam && Array.isArray(fam.items)) {
      if (!isPlainObject(c.answers)) {
        err('case.answers-type', `${label}.answers must be an object or null`);
      } else {
        const famNumbers = new Set(fam.items.filter((i) => isPlainObject(i)).map((i) => String(i.n)));
        for (const [k, v] of Object.entries(c.answers)) {
          if (!famNumbers.has(k)) {
            err('case.answer-unknown-item', `${label}.answers references item ${k}, which is not in family ${c.family}`);
          }
          const isBlank = v === '' || v === null || v === undefined;
          if (isBlank) continue;
          if (!isNonEmptyString(v)) {
            err('case.answer-type', `${label}.answers.${k} must be a non-empty string or a blank value`);
            continue;
          }
          const key = fam.items.find((i) => isPlainObject(i) && String(i.n) === k)?.key;
          // The scenario decides whether a marker or an out-of-vocabulary token is intentional.
          const pool = isPlainObject(fixture.optionPools) && isNonEmptyString(fam.optionPool) ? fixture.optionPools[fam.optionPool] : [];
          const legalToken = Array.isArray(pool) && pool.includes(v);
          const legalMarker = fam.noMatchSupported === true && v === fam.noMatchMarker;
          if (!legalToken && !legalMarker) {
            const scenarioPermitsIllegal = c.scenario === 'invalid-choice' || c.scenario === 'unsupported-no-match';
            if (!scenarioPermitsIllegal) {
              err('case.answer-illegal', `${label}.answers.${k} = "${v}" is not a legal token for ${c.family} and the scenario does not permit an illegal token`);
            }
          }
          if (v === 'x' && fam.noMatchSupported === false
              && c.scenario !== 'unsupported-no-match'
              && c.scenario !== 'invalid-choice'
              && c.scenario !== 'no-match-marked-where-not-expected') {
            err('case.answer-unsupported-no-match', `${label} uses the no-match marker in ${c.family}, which does not support it`);
          }
          void key;
        }
      }
    }

    /* Recompute the expected score for marked per-item cases. */
    const isMarked = c.expectedOutcome === 'marked' || c.expectedOutcome === 'marked-or-flagged';
    if (hasAnswers && fam && Array.isArray(fam.items) && isPlainObject(c.answers) && isMarked) {
      // A declared expectation must be a number of the right type and must be present:
      // omitting the correct count while asserting points would otherwise skip the check.
      const hasCount = c.expectedCorrectCount !== null && c.expectedCorrectCount !== undefined;
      const hasPoints = c.expectedPoints !== null && c.expectedPoints !== undefined;
      if (!hasCount || !hasPoints) {
        err('case.expectation-missing', `${label} is a marked case with answers, so both expectedCorrectCount and expectedPoints are required (use an explicit null only for a non-marked case)`);
      }
      if (hasCount && !Number.isInteger(c.expectedCorrectCount)) {
        err('case.correct-count-type', `${label}.expectedCorrectCount must be an integer, got ${JSON.stringify(c.expectedCorrectCount)}`);
      }
      if (hasPoints && (typeof c.expectedPoints !== 'number' || !Number.isFinite(c.expectedPoints))) {
        err('case.points-type', `${label}.expectedPoints must be a finite number, got ${JSON.stringify(c.expectedPoints)}`);
      }

      const perItem = fam.pointsMax / fam.items.length;
      let correct = 0;
      const usedKeys = new Map();
      for (const it of fam.items) {
        if (!isPlainObject(it)) continue;
        const given = c.answers[String(it.n)];
        const isBlank = given === '' || given === null || given === undefined;
        if (isBlank) continue;
        if (given !== it.key) continue;
        // A repeated selection cannot be credited twice where the family is single-use.
        if (isPositiveInteger(fam.reuseLimit) && fam.reuseLimit === 1 && given !== fam.noMatchMarker) {
          const seen = usedKeys.get(given) || 0;
          usedKeys.set(given, seen + 1);
          if (seen > 0) continue;
        }
        correct += 1;
      }
      const points = correct * perItem;
      if (Number.isInteger(c.expectedCorrectCount) && c.expectedCorrectCount !== correct) {
        err('case.correct-count', `${label} declares ${c.expectedCorrectCount} correct but the key and answers give ${correct}`);
      }
      if (typeof c.expectedPoints === 'number' && Number.isFinite(c.expectedPoints) && !close(c.expectedPoints, points)) {
        err('case.points', `${label} declares ${c.expectedPoints} points but ${correct} x ${perItem} = ${points}`);
      }
    }

    /* Aggregate cases must not claim a learner score. */
    if (c.scenario === 'family-weight-aggregation' && objectivePoints !== 180) {
      err('case.aggregate-total', `${label} expects 180 objective points but the family maxima sum to ${objectivePoints}`);
    }
    // No fixture may assert a whole-exam learner result: the pilot cannot compute one because
    // the oral part is unassessed. Presence is the defect, not the value: a numeric or boolean
    // claim (`learnerScore: 42`, `passed: false`, `readiness: 0.9`) is just as wrong as a string
    // one, and must not slip through a word-list scan.
    const claimFields = ['expectedGrade', 'gradeBand', 'readiness', 'overallResult', 'passed',
      'learnerScore', 'percentage', 'overallPassed', 'certificate', 'finalGrade'];
    for (const field of claimFields) {
      if (c[field] === undefined || c[field] === null) continue;
      err('case.prohibited-learner-claim', `${label}.${field} asserts a learner result; the pilot cannot compute an overall pass, grade or readiness`);
    }
    // A string outcome that names a pass/fail/band is also a claim, checked separately so that
    // the legitimate outcome vocabulary ("marked", "aggregate", "unassessed") stays allowed.
    if (isNonEmptyString(c.expectedOutcome)) {
      const value = c.expectedOutcome.toLowerCase().trim();
      const hit = PROHIBITED_LEARNER_CLAIMS.find((w) => value === w);
      if (hit) {
        err('case.prohibited-learner-claim', `${label}.expectedOutcome "${c.expectedOutcome}" asserts a learner result; the pilot cannot compute an overall pass, grade or readiness`);
      }
    }
    if (isPlainObject(c.expected)) {
      for (const field of claimFields) {
        if (c.expected[field] !== undefined && c.expected[field] !== null) {
          err('case.prohibited-learner-claim', `${label}.expected.${field} asserts a learner result; the pilot cannot compute an overall pass, grade or readiness`);
        }
      }
    }

    /* Unassessed cases must not carry points or a mark. */
    if (c.unassessed === true || c.expectedOutcome === 'unassessed') {
      if (c.expectedPoints !== null && c.expectedPoints !== undefined) {
        err('case.unassessed-points', `${label} is unassessed but declares expectedPoints`);
      }
      if (c.expectedCorrectCount !== null && c.expectedCorrectCount !== undefined) {
        err('case.unassessed-correct', `${label} is unassessed but declares expectedCorrectCount`);
      }
    }
  });

  if (seenScenarios.size < 8) {
    warn('coverage.scenarios', `only ${seenScenarios.size} distinct scenarios are covered`);
  }
  summary.scenarios = seenScenarios.size;
  summary.cases = fixture.cases.length;

  return { ok: errors.length === 0, errors, warnings, summary, families };
}

/* -------------------------------------------------------------------- CLI */
export function runCli(argv = process.argv.slice(2), io = console) {
  const target = argv.find((a) => !a.startsWith('-')) || DEFAULT_FIXTURE_PATH;
  const abs = path.resolve(target);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    io.error(`Cannot read objective fixtures: ${abs}\n  ${e.message}`);
    return 1;
  }
  const r = validateObjectiveCases(parsed);
  io.log(`objective-fixture-check: ${abs}`);
  io.log(`  families=${r.summary.families} cases=${r.summary.cases} scenarios=${r.summary.scenarios} objectiveItems=1-${r.summary.objectiveItems} objectivePoints=${r.summary.objectivePoints}`);
  for (const w of r.warnings) io.log(`  WARN  ${w}`);
  for (const e of r.errors) io.error(`  ERROR ${e}`);
  if (r.ok) {
    io.log(`  OK    fixtures are structurally sound (${r.warnings.length} warning(s)).`);
    io.log('  NOTE  this checks shape and weight arithmetic only; it does not mark work,');
    io.log('        does not implement authoritative scoring and does not decide pass/fail.');
    return 0;
  }
  io.error(`  FAIL  ${r.errors.length} error(s).`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(runCli());
}

/**
 * Read-only consistency checker for the telc B1 written-examination draft blueprint.
 *
 * Scope (USER-03 Task 2): this validates the *internal consistency* of
 * `docs/exam/telc-b1-written-draft.json` — schema shape, unique section/part
 * definitions, item-count and points arithmetic, timings and playback values, and
 * source-reference integrity. It reads nothing else, writes nothing, integrates with
 * no application code and migrates no scoring.
 *
 * It establishes internal consistency ONLY. It cannot establish exam validity, and it
 * refuses to let any payload assert approval: `review.approvedBy` must stay null,
 * `review.status` may not be `approved`, `gates.*.satisfied` may not become true from
 * inside the artifact, and no section may claim an oral or overall-pass result.
 *
 * Dependency-free. Usage:
 *   node tools/exam-blueprint-check.mjs [path-to-blueprint.json]
 * Exit code 0 when consistent, 1 on any error (warnings do not fail the run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BLUEPRINT_PATH = path.join(HERE, '..', 'docs', 'exam', 'telc-b1-written-draft.json');

export const EXPECTED_VERSION = '0.1.0-draft';
export const ALLOWED_REVIEW_STATUS = ['unreviewed', 'reviewed'];
export const FORBIDDEN_REVIEW_STATUS = ['approved', 'published', 'validated', 'certified'];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_LOCATOR_PATTERN = /^S[0-9]+(?:-p[0-9]+-p[0-9]+)?$/;
/** Subtest ids that must never be asserted as assessed in this pilot. */
const ORAL_OR_OVERALL_TOKENS = ['mundlich', 'mündlich', 'muendlich', 'oral', 'sprechen', 'speaking', 'overall', 'gesamt'];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;

/** Round to 6 dp to keep float comparison of percentages honest. */
const close = (a, b) => Math.abs(a - b) < 1e-6;

/**
 * Pure validator. No I/O, no globals, no side effects.
 *
 * There is deliberately no option to relax the approval guards: approval cannot be
 * elevated from inside this artifact under any call shape.
 *
 * @param {unknown} blueprint parsed blueprint object
 * @returns {{ok: boolean, errors: string[], warnings: string[], summary: object}}
 */
export function validateBlueprint(blueprint) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push(`[${code}] ${detail}`);
  const warn = (code, detail) => warnings.push(`[${code}] ${detail}`);
  const summary = { sections: 0, parts: 0, items: 0, objectivePoints: 0, writtenPoints: null, totalMinutes: null };

  if (!isPlainObject(blueprint)) {
    err('schema.root', 'blueprint must be a JSON object');
    return { ok: false, errors, warnings, summary };
  }

  /* ------------------------------------------------------------ version */
  if (!isNonEmptyString(blueprint.version)) {
    err('version.missing', 'version must be a non-empty string');
  } else if (blueprint.version !== EXPECTED_VERSION) {
    err('version.unexpected', `version must be "${EXPECTED_VERSION}", got "${blueprint.version}"`);
  }

  /* --------------------------------------------------------------- exam */
  if (!isPlainObject(blueprint.exam)) {
    err('exam.missing', 'exam object is required');
  } else {
    if (!isNonEmptyString(blueprint.exam.id)) err('exam.id', 'exam.id must be a non-empty string');
    if (!isNonEmptyString(blueprint.exam.title)) err('exam.title', 'exam.title must be a non-empty string');
  }

  /* -------------------------------------------------------------- scope */
  const scope = blueprint.scope;
  if (!isPlainObject(scope)) {
    err('scope.missing', 'scope object is required');
  } else {
    if (!Array.isArray(scope.included) || scope.included.length === 0) {
      err('scope.included', 'scope.included must be a non-empty array');
    }
    if (!Array.isArray(scope.excluded) || scope.excluded.length === 0) {
      err('scope.excluded', 'scope.excluded must be a non-empty array listing exclusions');
    }
    if (!isPlainObject(scope.overallPassInference)) {
      err('scope.overallPassInference', 'scope.overallPassInference is required');
    } else if (scope.overallPassInference.allowed !== false) {
      err('scope.overall-pass-claim', 'scope.overallPassInference.allowed must be false: oral is unassessed, so no overall pass may be inferred');
    }
  }

  /* ------------------------------------------------------------ sources */
  const sourceIds = new Set();
  /** Source id -> verified printedPage to PDF page offset, when declared. */
  const sourcePageOffset = new Map();
  /** Source ids that declare a page count, for upper-bound checks. */
  const sourcePageCount = new Map();
  if (!Array.isArray(blueprint.sources) || blueprint.sources.length === 0) {
    err('sources.missing', 'sources must be a non-empty array');
  } else {
    blueprint.sources.forEach((s, i) => {
      const at = `sources[${i}]`;
      if (!isPlainObject(s)) return err('sources.entry', `${at} must be an object`);
      if (!isNonEmptyString(s.id)) return err('sources.id', `${at}.id must be a non-empty string`);
      if (sourceIds.has(s.id)) return err('sources.duplicate-id', `${at}.id "${s.id}" is duplicated`);
      sourceIds.add(s.id);
      if (!isNonEmptyString(s.url) && !isNonEmptyString(s.locatorNote)) {
        err('sources.locator', `${at} needs a url or a locatorNote`);
      }
      if (!isNonEmptyString(s.retrieved)) {
        err('sources.retrieved', `${at}.retrieved date is required`);
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(s.retrieved)) {
        err('sources.retrieved-format', `${at}.retrieved must be YYYY-MM-DD, got "${s.retrieved}"`);
      } else if (s.retrieved > new Date().toISOString().slice(0, 10)) {
        // A retrieval event cannot be dated in the future.
        err('sources.retrieved-future', `${at}.retrieved "${s.retrieved}" is in the future`);
      }
      if (!isNonEmptyString(s.verification)) {
        err('sources.verification', `${at}.verification is required (how it was verified)`);
      }
      if (s.pageOffset !== undefined && s.pageOffset !== null) {
        if (!isPlainObject(s.pageOffset)) {
          err('sources.page-offset-type', `${at}.pageOffset must be an object`);
        } else if (!isPositiveInteger(s.pageOffset.printedToPdf)) {
          err('sources.page-offset-value', `${at}.pageOffset.printedToPdf must be a positive integer`);
        } else if (s.pageOffset.verified !== true) {
          err('sources.page-offset-unverified', `${at}.pageOffset is declared but not marked verified; an unverified offset must not be used to validate citations`);
        } else {
          sourcePageOffset.set(s.id, s.pageOffset.printedToPdf);
        }
      }
      if (isPositiveInteger(s.pages)) sourcePageCount.set(s.id, s.pages);
    });
  }

  /* ----------------------------------------------------------- sections */
  if (!Array.isArray(blueprint.sections) || blueprint.sections.length === 0) {
    err('sections.missing', 'sections must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings, summary };
  }

  const seenSectionIds = new Set();
  const seenPartIds = new Set();
  const seenOrders = new Set();
  const partById = new Map();
  const sharedBlocks = new Map();
  let objectivePoints = 0;
  let writtenPoints = 0;
  let totalItems = 0;

  blueprint.sections.forEach((section, si) => {
    const sat = `sections[${si}]`;
    if (!isPlainObject(section)) return err('section.type', `${sat} must be an object`);
    const label = isNonEmptyString(section.id) ? section.id : sat;

    if (!isNonEmptyString(section.id)) {
      err('section.id', `${sat}.id must be a non-empty string`);
    } else if (!ID_PATTERN.test(section.id)) {
      err('section.id-format', `${sat}.id "${section.id}" must be lowercase kebab-case`);
    } else if (seenSectionIds.has(section.id)) {
      err('section.duplicate-id', `section id "${section.id}" is defined more than once`);
    } else {
      seenSectionIds.add(section.id);
    }

    if (!isPositiveInteger(section.order)) {
      err('section.order', `${label}.order must be a positive integer`);
    } else if (seenOrders.has(section.order)) {
      err('section.duplicate-order', `section order ${section.order} is used more than once`);
    } else {
      seenOrders.add(section.order);
    }

    if (!isNonEmptyString(section.subtest)) err('section.subtest', `${label}.subtest is required`);
    if (typeof section.objective !== 'boolean') err('section.objective', `${label}.objective must be a boolean`);

    // Guard: the pilot excludes speaking; no section may assert an oral/overall result.
    const haystack = `${section.id} ${section.subtest} ${section.subtestEn || ''}`.toLowerCase();
    if (ORAL_OR_OVERALL_TOKENS.some((t) => haystack.includes(t))) {
      err('section.oral-claim', `${label} asserts an oral/overall component, which this pilot must not assess`);
    }
    if (section.assessedInPilot !== true) {
      err('section.assessed', `${label}.assessedInPilot must be true for an included written subtest`);
    }

    /* timing */
    const timing = section.timing;
    if (!isPlainObject(timing)) {
      err('timing.missing', `${label}.timing is required`);
    } else {
      if (!['own-block', 'shared-block'].includes(timing.kind)) {
        err('timing.kind', `${label}.timing.kind must be "own-block" or "shared-block"`);
      }
      if (!isPositiveInteger(timing.minutes)) {
        err('timing.minutes', `${label}.timing.minutes must be a positive integer`);
      }
      if (typeof timing.breakWithinBlock !== 'boolean') {
        err('timing.break', `${label}.timing.breakWithinBlock must be a boolean`);
      }
      if (timing.kind === 'shared-block') {
        if (!isNonEmptyString(timing.sharedBlockId)) {
          err('timing.shared-block-id', `${label}.timing.sharedBlockId is required for a shared block`);
        } else {
          const prev = sharedBlocks.get(timing.sharedBlockId);
          if (prev && prev.minutes !== timing.minutes) {
            err('timing.shared-block-mismatch', `shared block "${timing.sharedBlockId}" declares ${prev.minutes} minutes in ${prev.section} but ${timing.minutes} in ${label}`);
          } else if (!prev) {
            sharedBlocks.set(timing.sharedBlockId, { minutes: timing.minutes, section: label });
          }
        }
      } else if (timing.sharedBlockId !== null && timing.sharedBlockId !== undefined) {
        err('timing.shared-block-id-unexpected', `${label}.timing.sharedBlockId must be null for an own block`);
      }
    }

    /* points */
    const points = section.points;
    if (!isPlainObject(points)) {
      err('points.missing', `${label}.points is required`);
    } else {
      if (!isPositiveInteger(points.max)) {
        err('points.max', `${label}.points.max must be a positive integer`);
      }
      if (!isPositiveInteger(points.weightPercent)) {
        err('points.weightPercent', `${label}.points.weightPercent must be a positive integer`);
      }
    }

    /* items at section level */
    const secItems = section.items;
    if (!isPlainObject(secItems) || !isPositiveInteger(secItems.count)) {
      err('items.count', `${label}.items.count must be a positive integer`);
    }

    /* parts */
    if (!Array.isArray(section.parts) || section.parts.length === 0) {
      err('parts.missing', `${label}.parts must be a non-empty array`);
      return;
    }
    const seenPartOrders = new Set();
    let partItemSum = 0;
    let partPoints = [];
    let expectedFirst = isPlainObject(secItems) && isPositiveInteger(secItems.first) ? secItems.first : null;

    section.parts.forEach((part, pi) => {
      const pat = `${label}.parts[${pi}]`;
      if (!isPlainObject(part)) return err('part.type', `${pat} must be an object`);
      const plabel = isNonEmptyString(part.id) ? part.id : pat;

      if (!isNonEmptyString(part.id)) {
        err('part.id', `${pat}.id must be a non-empty string`);
      } else if (!ID_PATTERN.test(part.id)) {
        err('part.id-format', `${pat}.id "${part.id}" must be lowercase kebab-case`);
      } else if (seenPartIds.has(part.id)) {
        err('part.duplicate-id', `part id "${part.id}" is defined more than once (part ids must be globally unique)`);
      } else {
        seenPartIds.add(part.id);
        partById.set(part.id, part);
      }

      if (!isPositiveInteger(part.order)) {
        err('part.order', `${plabel}.order must be a positive integer`);
      } else if (seenPartOrders.has(part.order)) {
        err('part.duplicate-order', `${label}: part order ${part.order} is used more than once`);
      } else {
        seenPartOrders.add(part.order);
      }

      if (!isNonEmptyString(part.taskFamily)) err('part.task-family', `${plabel}.taskFamily is required`);
      if (!isNonEmptyString(part.responseFormat)) err('part.responseFormat', `${plabel}.responseFormat is required`);
      if (!['matching', 'multiple-choice', 'true-false', 'gap-fill-from-options', 'writing-task', 'free-text-email'].includes(part.taskFamily)) {
        err('part.task-family-unsupported', `${plabel}.taskFamily "${part.taskFamily}" is not a supported family`);
      }

      /* item counts */
      const pItems = part.items;
      if (!isPlainObject(pItems) || !isPositiveInteger(pItems.count)) {
        err('part.items.count', `${plabel}.items.count must be a positive integer`);
      } else {
        partItemSum += pItems.count;
        const hasFirst = pItems.first !== null && pItems.first !== undefined;
        const hasLast = pItems.last !== null && pItems.last !== undefined;
        if (hasFirst !== hasLast) {
          err('part.items.range-incomplete', `${plabel}.items must set both first and last, or neither`);
        }
        if (hasFirst) {
          if (!isPositiveInteger(pItems.first)) err('part.items.first', `${plabel}.items.first must be a positive integer`);
          if (!isPositiveInteger(pItems.last)) err('part.items.last', `${plabel}.items.last must be a positive integer`);
          if (isPositiveInteger(pItems.first) && isPositiveInteger(pItems.last)) {
            if (pItems.last < pItems.first) {
              err('part.items.range-order', `${plabel}.items.last (${pItems.last}) is before first (${pItems.first})`);
            }
            if (pItems.last - pItems.first + 1 !== pItems.count) {
              err('part.items.range-count', `${plabel}: count ${pItems.count} does not match range ${pItems.first}-${pItems.last}`);
            }
            if (expectedFirst !== null && pItems.first !== expectedFirst) {
              err('part.items.not-contiguous', `${plabel}.items.first is ${pItems.first} but the next expected item number is ${expectedFirst}`);
            }
            expectedFirst = pItems.last + 1;
          }
        }
      }

      /* points */
      if (!isPositiveInteger(part.points)) {
        err('part.points', `${plabel}.points must be a positive integer`);
      } else {
        partPoints.push({ id: plabel, points: part.points });
      }

      /* playback must be explicit for listening parts */
      if (part.taskFamily === 'true-false' || part.permittedPlays !== undefined) {
        if (!isPositiveInteger(part.permittedPlays)) {
          err('part.plays', `${plabel}.permittedPlays must be a positive integer for an audio part`);
        }
      }

      /* reuse / option coherence */
      if (part.optionLabelRange !== undefined && part.optionLabelRange !== null && !isNonEmptyString(part.optionLabelRange)) {
        err('part.option-label-range', `${plabel}.optionLabelRange must be a string like "a-j"`);
      }
      if (isPositiveInteger(part.optionCount) && isPositiveInteger(part.reuseLimit) && isPositiveInteger(pItems?.count)) {
        if (part.reuseLimit * pItems.count > part.optionCount) {
          warn('part.option-supply', `${plabel}: ${part.reuseLimit} use(s) x ${pItems.count} items needs ${part.reuseLimit * pItems.count} options but only ${part.optionCount} are listed`);
        }
      }
      if (part.noMatchAllowed !== undefined && part.noMatchAllowed !== null && typeof part.noMatchAllowed !== 'boolean') {
        err('part.no-match', `${plabel}.noMatchAllowed must be a boolean or null`);
      }
      if (part.noMatchAllowed === true && !isNonEmptyString(part.noMatchMarker)) {
        err('part.no-match-marker', `${plabel} allows no-match but does not state noMatchMarker`);
      }

      /* writing criteria */
      const isWritingFamily = part.taskFamily === 'writing-task' || part.taskFamily === 'free-text-email';
      const hasWritingShape = part.criteria !== undefined || part.bandToTotal !== undefined || part.requiredContentPoints !== undefined;
      if (hasWritingShape && !isWritingFamily) {
        err('part.writing-shape-family', `${plabel} carries writing criteria/bandToTotal/requiredContentPoints but its taskFamily "${part.taskFamily}" is not a writing family`);
      }
      if (part.taskFamily === 'writing-task' || part.criteria !== undefined) {
        if (!isPositiveInteger(part.requiredContentPoints)) {
          err('part.content-points', `${plabel}.requiredContentPoints must be a positive integer`);
        }
        if (!Array.isArray(part.criteria) || part.criteria.length === 0) {
          err('part.criteria', `${plabel}.criteria must be a non-empty array`);
        } else {
          const critIds = new Set();
          let critSum = 0;
          part.criteria.forEach((c, ci) => {
            const cat = `${plabel}.criteria[${ci}]`;
            if (!isPlainObject(c)) return err('criterion.type', `${cat} must be an object`);
            if (!isNonEmptyString(c.id)) err('criterion.id', `${cat}.id is required`);
            else if (critIds.has(c.id)) err('criterion.duplicate-id', `${cat}.id "${c.id}" is duplicated`);
            else critIds.add(c.id);
            if (!isNonEmptyString(c.name)) err('criterion.name', `${cat}.name is required`);
            if (!Array.isArray(c.bands) || c.bands.length === 0) {
              err('criterion.bands', `${cat}.bands must be a non-empty array`);
            } else {
              // Bands must be unique, and bandPoints must describe exactly those bands.
              const seenBands = new Set();
              for (const band of c.bands) {
                if (!isNonEmptyString(band)) {
                  err('criterion.band-type', `${cat}.bands contains a non-string entry`);
                } else if (seenBands.has(band)) {
                  err('criterion.band-duplicate', `${cat}.bands lists "${band}" more than once`);
                } else {
                  seenBands.add(band);
                }
              }
            }
            if (!isPlainObject(c.bandPoints)) {
              err('criterion.band-points', `${cat}.bandPoints must be an object`);
            } else {
              for (const [band, pts] of Object.entries(c.bandPoints)) {
                if (!isNonNegativeInteger(pts)) {
                  err('criterion.band-point-invalid', `${cat}.bandPoints.${band} must be a non-negative integer`);
                }
              }
              if (Array.isArray(c.bands)) {
                for (const band of c.bands) {
                  if (!(band in c.bandPoints)) {
                    err('criterion.band-missing-points', `${cat}: band "${band}" has no bandPoints entry`);
                  }
                }
                for (const band of Object.keys(c.bandPoints)) {
                  if (!c.bands.includes(band)) {
                    err('criterion.points-extra-band', `${cat}.bandPoints declares "${band}" which is not listed in bands`);
                  }
                }
              }
              const vals = Object.values(c.bandPoints).filter(isFiniteNumber);
              if (vals.length) {
                const max = Math.max(...vals);
                if (vals.some((v) => v < 0)) {
                  err('criterion.band-negative', `${cat}.bandPoints contains a negative value`);
                }
                if (!vals.includes(0)) {
                  warn('criterion.band-no-zero', `${cat}.bandPoints has no zero band; B1 writing criteria include a 0 band`);
                }
                critSum += max;
              }
            }
          });
          const b2t = part.bandToTotal;
          if (!isPlainObject(b2t)) {
            err('part.band-to-total', `${plabel}.bandToTotal is required for a writing task`);
          } else {
            // Every arithmetic input must be present before any arithmetic is attempted; a
            // missing field must not silently skip the consistency check.
            for (const field of ['multiplier', 'rawCriterionMax', 'subtestMax']) {
              if (!isPositiveInteger(b2t[field])) {
                err('band-to-total.missing-field', `${plabel}.bandToTotal.${field} must be a positive integer`);
              }
            }
            if (!isNonEmptyString(b2t.formula)) {
              err('band-to-total.formula-missing', `${plabel}.bandToTotal.formula is required`);
            }
            if (isPositiveInteger(b2t.rawCriterionMax) && critSum !== b2t.rawCriterionMax) {
              err('band-to-total.raw-mismatch', `${plabel}: criterion maxima sum to ${critSum} but bandToTotal.rawCriterionMax is ${b2t.rawCriterionMax}`);
            }
            if (isPositiveInteger(b2t.multiplier) && isPositiveInteger(b2t.rawCriterionMax) && isPositiveInteger(b2t.subtestMax)) {
              if (b2t.rawCriterionMax * b2t.multiplier !== b2t.subtestMax) {
                err('band-to-total.subtest-mismatch', `${plabel}: ${b2t.rawCriterionMax} x ${b2t.multiplier} != subtestMax ${b2t.subtestMax}`);
              }
              if (isPositiveInteger(part.points) && b2t.subtestMax !== part.points) {
                err('band-to-total.points-mismatch', `${plabel}: bandToTotal.subtestMax ${b2t.subtestMax} != part points ${part.points}`);
              }
            }
            if (isNonEmptyString(b2t.formula) && isPositiveInteger(b2t.multiplier) && b2t.formula !== `(k1 + k2 + k3) * ${b2t.multiplier}`) {
              err('band-to-total.formula', `${plabel}.bandToTotal.formula "${b2t.formula}" does not match the three-criterion multiplier`);
            }
            checkSources(b2t.sources, `${plabel}.bandToTotal.sources`);
          }
          // Rating procedure is part of the verified writing rules and must cite its source.
          if (!isPlainObject(part.ratingProcedure)) {
            err('part.rating-procedure', `${plabel}.ratingProcedure is required for a writing task`);
          } else {
            if (part.ratingProcedure.independentRaters !== 2) {
              err('part.rating-procedure-raters', `${plabel}.ratingProcedure.independentRaters must be 2 per the verified rule`);
            }
            if (part.ratingProcedure.secondRatingOverridesFirstOnDifference !== true) {
              err('part.rating-procedure-override', `${plabel}.ratingProcedure.secondRatingOverridesFirstOnDifference must be true`);
            }
            if (part.ratingProcedure.finalRatingByPublisher !== true) {
              err('part.rating-procedure-final', `${plabel}.ratingProcedure.finalRatingByPublisher must be true`);
            }
            checkSources(part.ratingProcedure.sources, `${plabel}.ratingProcedure.sources`);
          }
        }
      }

      /* part sources */
      checkSources(part.sources, `${plabel}.sources`);
    });

    /* section-level aggregation */
    if (isPlainObject(secItems) && isPositiveInteger(secItems.count) && partItemSum !== secItems.count) {
      err('section.items.sum', `${label}: part item counts sum to ${partItemSum} but section declares ${secItems.count}`);
    }
    if (isPlainObject(secItems) && isPositiveInteger(secItems.first) && isPositiveInteger(secItems.last)) {
      if (secItems.last - secItems.first + 1 !== secItems.count) {
        err('section.items.range-count', `${label}: section range ${secItems.first}-${secItems.last} does not match count ${secItems.count}`);
      }
    }
    // Objective parts inside one section share a per-part maximum in this blueprint, and the
    // declared section maximum must equal the actual sum of those part points. Checking only
    // that the per-part values agree with each other would let every part change to the same
    // wrong value while the section maximum stayed put.
    if (section.objective === true && partPoints.length > 0) {
      const values = [...new Set(partPoints.map((p) => p.points))];
      if (values.length > 1) {
        err('section.part-points-vary', `${label}: objective parts declare differing points (${values.join(', ')}); the source gives one per-part maximum per subtest`);
      }
      const actualSum = partPoints.reduce((sum, p) => sum + p.points, 0);
      if (isPlainObject(points) && isPositiveInteger(points.max) && actualSum !== points.max) {
        err('section.points.sum', `${label}: part points sum to ${actualSum} but the section declares max ${points.max}`);
      }
      if (isPlainObject(points) && isPositiveInteger(points.raw) && isPositiveInteger(points.max)) {
        const expected = points.raw * section.parts.length;
        if (expected !== points.max) {
          err('section.points.sum', `${label}: raw ${points.raw} x ${section.parts.length} parts = ${expected} but max is ${points.max}`);
        }
      }
    }
    if (isPlainObject(points) && isPositiveInteger(points.max)) {
      if (section.objective === true) objectivePoints += points.max;
      writtenPoints += points.max;
    }
    if (isPlainObject(secItems) && isPositiveInteger(secItems.count)) totalItems += secItems.count;

    checkSources(section.sources, `${label}.sources`);
    if (Array.isArray(section.answerRuleRefs)) {
      for (const ref of section.answerRuleRefs) {
        if (!isNonEmptyString(ref)) err('section.answer-rule-ref', `${label}.answerRuleRefs contains a non-string entry`);
      }
    }
  });

  /* ------------------------------------- objective item-number continuity */
  // Objective items in a telc written paper are numbered 1..N in section order.
  const objectiveSections = blueprint.sections
    .filter((s) => isPlainObject(s) && s.objective === true)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  let expectedItemNumber = 1;
  for (const s of objectiveSections) {
    const first = isPlainObject(s.items) ? s.items.first : null;
    const last = isPlainObject(s.items) ? s.items.last : null;
    if (!isPositiveInteger(first) || !isPositiveInteger(last)) {
      err('items.objective-numbering', `section "${s.id}" must declare a numeric first/last item range`);
      continue;
    }
    if (first !== expectedItemNumber) {
      err('items.objective-gap', `objective items must be numbered 1..N contiguously across sections; section "${s.id}" starts at ${first} but ${expectedItemNumber} was expected`);
    }
    expectedItemNumber = last + 1;
  }
  summary.objectiveItemsLast = expectedItemNumber - 1;

  /* -------------------------------------------------------- answer rules */
  const ruleIds = new Set();
  if (!Array.isArray(blueprint.answerRules) || blueprint.answerRules.length === 0) {
    err('rules.missing', 'answerRules must be a non-empty array');
  } else {
    blueprint.answerRules.forEach((r, ri) => {
      const rat = `answerRules[${ri}]`;
      if (!isPlainObject(r)) return err('rule.type', `${rat} must be an object`);
      if (!isNonEmptyString(r.id)) {
        err('rule.id', `${rat}.id must be a non-empty string`);
      } else if (ruleIds.has(r.id)) {
        err('rule.duplicate-id', `${rat}.id "${r.id}" is duplicated`);
      } else {
        ruleIds.add(r.id);
      }
      if (!isNonEmptyString(r.rule)) err('rule.text', `${rat}.rule text is required`);
      if (!Array.isArray(r.appliesTo) || r.appliesTo.length === 0) {
        err('rule.applies-to', `${rat}.appliesTo must be a non-empty array`);
      } else {
        for (const pid of r.appliesTo) {
          if (!partById.has(pid)) {
            err('rule.unknown-part', `${rat}.appliesTo references unknown part "${pid}"`);
          }
        }
      }
      checkSources(r.sources, `${rat}.sources`);
    });
    // every section/part rule reference must resolve
    blueprint.sections.forEach((section) => {
      if (!isPlainObject(section)) return; // already reported as section.type
      for (const ref of section.answerRuleRefs || []) {
        if (!ruleIds.has(ref)) {
          err('rule.unknown-reference', `section "${section.id}" references unknown answer rule "${ref}"`);
        }
      }
    });
    // playback values must match the source-stated pattern per part
    for (const [pid, part] of partById) {
      if (part.permittedPlays !== undefined && part.permittedPlays !== null) {
        if (!isPositiveInteger(part.permittedPlays)) {
          err('plays.invalid', `part "${pid}".permittedPlays must be a positive integer`);
        } else if (part.permittedPlays > 2) {
          err('plays.unsupported', `part "${pid}".permittedPlays is ${part.permittedPlays}; the verified source permits at most two plays`);
        }
      }
    }
  }

  /* ------------------------------------------------- writtenExam aggregate */
  const we = blueprint.writtenExam;
  if (!isPlainObject(we)) {
    err('writtenExam.missing', 'writtenExam object is required');
  } else {
    // These are the arithmetic inputs behind the written pass rule. A missing field must be
    // reported, not silently skipped, or a blueprint could drop its threshold entirely.
    for (const field of ['totalMinutes', 'writtenAggregatePoints', 'totalPointsAllParts', 'oralPoints',
      'writtenWeightPercent', 'oralWeightPercent', 'writtenPassPoints', 'writtenPassPercent',
      'oralPassPoints', 'oralPassPercent']) {
      if (!isPositiveInteger(we[field])) {
        err('writtenExam.missing-field', `writtenExam.${field} must be a positive integer`);
      }
    }
    for (const flag of ['thresholdAppliesPerPart', 'thresholdAppliesPerSubtest']) {
      if (typeof we[flag] !== 'boolean') {
        err('writtenExam.missing-flag', `writtenExam.${flag} must be a boolean`);
      }
    }
    const minutesFromSections = blueprint.sections.reduce((sum, s) => {
      if (!isPlainObject(s) || !isPlainObject(s.timing) || !isPositiveInteger(s.timing.minutes)) return sum;
      return sum + (s.timing.kind === 'shared-block' ? 0 : s.timing.minutes);
    }, 0);
    // shared blocks count once
    const sharedMinutes = [...sharedBlocks.values()].reduce((sum, b) => sum + (isPositiveInteger(b.minutes) ? b.minutes : 0), 0);
    const totalMinutes = minutesFromSections + sharedMinutes;
    summary.totalMinutes = totalMinutes;
    if (!isPositiveInteger(we.totalMinutes)) {
      err('writtenExam.totalMinutes', 'writtenExam.totalMinutes must be a positive integer');
    } else if (totalMinutes !== we.totalMinutes) {
      err('writtenExam.minutes-mismatch', `section timings sum to ${totalMinutes} minutes but writtenExam.totalMinutes is ${we.totalMinutes}`);
    }
    if (!isPositiveInteger(we.writtenAggregatePoints)) {
      err('writtenExam.writtenAggregatePoints', 'writtenExam.writtenAggregatePoints must be a positive integer');
    } else if (writtenPoints !== we.writtenAggregatePoints) {
      err('writtenExam.points-mismatch', `section maxima sum to ${writtenPoints} but writtenExam.writtenAggregatePoints is ${we.writtenAggregatePoints}`);
    }
    if (!isPositiveInteger(we.objectivePointsMayDiffer)) { /* optional field; ignore */ }
    if (isPositiveInteger(we.writtenAggregatePoints) && isPositiveInteger(we.oralPoints) && isPositiveInteger(we.totalPointsAllParts)) {
      if (we.writtenAggregatePoints + we.oralPoints !== we.totalPointsAllParts) {
        err('writtenExam.total-mismatch', `${we.writtenAggregatePoints} + ${we.oralPoints} != ${we.totalPointsAllParts}`);
      }
    }
    if (isPositiveInteger(we.writtenWeightPercent) && isPositiveInteger(we.oralWeightPercent)) {
      if (we.writtenWeightPercent + we.oralWeightPercent !== 100) {
        err('writtenExam.weight-mismatch', `${we.writtenWeightPercent} + ${we.oralWeightPercent} != 100`);
      }
    }
    if (isPositiveInteger(we.writtenAggregatePoints) && isPositiveInteger(we.totalPointsAllParts) && isPositiveInteger(we.writtenWeightPercent)) {
      const expected = (we.writtenAggregatePoints / we.totalPointsAllParts) * 100;
      if (!close(expected, we.writtenWeightPercent)) {
        err('writtenExam.weight-inconsistent', `${we.writtenAggregatePoints}/${we.totalPointsAllParts} is ${expected.toFixed(2)} % but writtenWeightPercent is ${we.writtenWeightPercent}`);
      }
    }
    if (isPositiveInteger(we.writtenPassPoints) && isPositiveInteger(we.writtenPassPercent) && isPositiveInteger(we.writtenAggregatePoints)) {
      if (!close((we.writtenPassPercent / 100) * we.writtenAggregatePoints, we.writtenPassPoints)) {
        err('writtenExam.pass-mismatch', `${we.writtenPassPercent} % of ${we.writtenAggregatePoints} is not ${we.writtenPassPoints}`);
      }
    }
    if (isPositiveInteger(we.oralPassPoints) && isPositiveInteger(we.oralPassPercent) && isPositiveInteger(we.oralPoints)) {
      if (!close((we.oralPassPercent / 100) * we.oralPoints, we.oralPassPoints)) {
        err('writtenExam.oral-pass-mismatch', `${we.oralPassPercent} % of ${we.oralPoints} is not ${we.oralPassPoints}`);
      }
    }
    if (we.thresholdAppliesPerSubtest !== false) {
      err('writtenExam.threshold-scope', 'writtenExam.thresholdAppliesPerSubtest must be false: the 60 % threshold applies to the written and oral parts, not per subtest');
    }
    if (we.thresholdAppliesPerPart !== true) {
      err('writtenExam.threshold-per-part', 'writtenExam.thresholdAppliesPerPart must be true');
    }
    // section weights must sum to the declared written weight
    const weightSum = blueprint.sections.reduce((sum, s) => sum + (isPlainObject(s?.points) && isPositiveInteger(s.points.weightPercent) ? s.points.weightPercent : 0), 0);
    if (isPositiveInteger(we.writtenWeightPercent) && weightSum !== we.writtenWeightPercent) {
      err('writtenExam.weight-sum', `section weights sum to ${weightSum} % but writtenWeightPercent is ${we.writtenWeightPercent}`);
    }
  }

  /* ----------------------------------------------------------- unresolved */
  if (!Array.isArray(blueprint.unresolved) || blueprint.unresolved.length === 0) {
    err('unresolved.missing', 'unresolved must be a non-empty array; gaps must be preserved explicitly rather than filled in');
  } else {
    const unIds = new Set();
    blueprint.unresolved.forEach((u, ui) => {
      const uat = `unresolved[${ui}]`;
      if (!isPlainObject(u)) return err('unresolved.type', `${uat} must be an object`);
      if (!isNonEmptyString(u.id)) err('unresolved.id', `${uat}.id is required`);
      else if (unIds.has(u.id)) err('unresolved.duplicate-id', `${uat}.id "${u.id}" is duplicated`);
      else unIds.add(u.id);
      if (!isNonEmptyString(u.question)) err('unresolved.question', `${uat}.question is required`);
      if (u.status !== 'unresolved') {
        err('unresolved.status', `${uat}.status must be "unresolved" (got ${JSON.stringify(u.status)}); do not fabricate resolution`);
      }
      checkSources(u.sources, `${uat}.sources`, { optional: true });
    });
  }

  /* --------------------------------------------------------------- gates */
  if (!isPlainObject(blueprint.gates)) {
    err('gates.missing', 'gates object is required');
  } else {
    for (const [name, gate] of Object.entries(blueprint.gates)) {
      if (!isPlainObject(gate)) {
        err('gate.type', `gates.${name} must be an object`);
        continue;
      }
      if (typeof gate.satisfied !== 'boolean') {
        err('gate.satisfied', `gates.${name}.satisfied must be a boolean`);
      } else if (gate.satisfied === true) {
        err('gate.self-approval', `gates.${name}.satisfied is true; this artifact may not assert that a human/expert gate has been satisfied`);
      }
    }
  }

  /* -------------------------------------------------------------- review */
  const review = blueprint.review;
  if (!isPlainObject(review)) {
    err('review.missing', 'review object is required');
  } else {
    if (!isNonEmptyString(review.status)) {
      err('review.status', 'review.status is required');
    } else if (FORBIDDEN_REVIEW_STATUS.includes(review.status)) {
      err('review.approval-claim', `review.status "${review.status}" is not permitted; a draft artifact may not claim approval`);
    } else if (!ALLOWED_REVIEW_STATUS.includes(review.status)) {
      err('review.status-unknown', `review.status "${review.status}" is not one of ${ALLOWED_REVIEW_STATUS.join(', ')}`);
    }
    if (review.approvedBy !== null) {
      err('review.approved-by', `review.approvedBy must be null in a draft (got ${JSON.stringify(review.approvedBy)}); approval requires a recorded human reviewer outside this artifact`);
    }
  }

  summary.sections = blueprint.sections.length;
  summary.parts = partById.size;
  summary.items = totalItems;
  summary.objectivePoints = objectivePoints;
  summary.writtenPoints = writtenPoints;

  /**
   * Schema-defined source-reference fields. Each must exist and be an array of valid
   * locators; the recursive walk below cannot catch a field that is simply absent, and
   * `typeof 'string'` must not be mistaken for a reference list.
   */
  const requiredSourceFields = [
    ['blueprint.writtenExam.sources', () => blueprint.writtenExam && blueprint.writtenExam.sources],
  ];
  blueprint.sections.forEach((section, si) => {
    const sLabel = isPlainObject(section) && isNonEmptyString(section.id) ? section.id : `sections[${si}]`;
    requiredSourceFields.push([`${sLabel}.sources`, () => (isPlainObject(section) ? section.sources : undefined)]);
    if (Array.isArray(section && section.parts)) {
      section.parts.forEach((part, pi) => {
        const pLabel = isPlainObject(part) && isNonEmptyString(part.id) ? part.id : `${sLabel}.parts[${pi}]`;
        requiredSourceFields.push([`${pLabel}.sources`, () => (isPlainObject(part) ? part.sources : undefined)]);
        if (Array.isArray(part && part.criteria)) {
          part.criteria.forEach((c, ci) => {
            const cLabel = isPlainObject(c) && isNonEmptyString(c.id) ? `${pLabel}.criteria.${c.id}` : `${pLabel}.criteria[${ci}]`;
            requiredSourceFields.push([`${cLabel}.sources`, () => (isPlainObject(c) ? c.sources : undefined)]);
          });
        }
        if (isPlainObject(part) && part.bandToTotal !== undefined) {
          requiredSourceFields.push([`${pLabel}.bandToTotal.sources`, () => part.bandToTotal && part.bandToTotal.sources]);
        }
        if (isPlainObject(part) && part.ratingProcedure !== undefined) {
          requiredSourceFields.push([`${pLabel}.ratingProcedure.sources`, () => part.ratingProcedure && part.ratingProcedure.sources]);
        }
      });
    }
  });
  (blueprint.answerRules || []).forEach((r, ri) => {
    const rLabel = isPlainObject(r) && isNonEmptyString(r.id) ? r.id : `answerRules[${ri}]`;
    requiredSourceFields.push([`${rLabel}.sources`, () => (isPlainObject(r) ? r.sources : undefined)]);
  });

  /** Source-reference paths already checked by the required-field pass above. */
  const checkedSourcePaths = new Set();
  for (const [at, get] of requiredSourceFields) {
    const refs = get();
    if (refs === undefined || refs === null) {
      err('sources.field-missing', `${at} is required; a source reference field may not be absent`);
      continue;
    }
    checkedSourcePaths.add(at);
    checkSources(refs, at);
  }

  /* ------------------------------------------- recursive source integrity */
  // Source references may also appear in nested blocks the schema list does not name.
  // Anything called `sources` anywhere in the payload is checked, so a reference cannot
  // hide in a block the per-section passes do not visit. Paths already validated above are
  // skipped so one bad field does not produce the same error twice.
  walkSourceRefs(blueprint, 'blueprint', 0, checkedSourcePaths);

  return { ok: errors.length === 0, errors, warnings, summary };

  /** Recursively validate every `sources` array found in the payload. */
  function walkSourceRefs(node, at, depth = 0, skip = new Set()) {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walkSourceRefs(child, `${at}[${i}]`, depth + 1, skip));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      // `blueprint.sources` is the source *definition* list, not a reference list.
      if (key === 'sources' && at !== 'blueprint') {
        const path = `${at}.sources`;
        // Already validated by the required-field pass; do not report the same defect twice.
        if (skip.has(path)) continue;
        // Absence and mistyping must both fail: a string is not a reference list, and a
        // missing field would otherwise skip validation while still claiming provenance.
        checkSources(value, path, { optional: true });
      } else if (value && typeof value === 'object') {
        walkSourceRefs(value, `${at}.${key}`, depth + 1, skip);
      }
    }
  }

  /* ------------------------------------------------------------- helper */
  function checkSources(refs, at, opts = {}) {
    if (refs === undefined || refs === null) {
      if (!opts.optional) err('sources.missing-refs', `${at} is required`);
      return;
    }
    if (!Array.isArray(refs)) {
      err('sources.refs-type', `${at} must be an array`);
      return;
    }
    if (refs.length === 0) {
      if (!opts.optional) err('sources.empty', `${at} must cite at least one source`);
      return;
    }
    for (const ref of refs) {
      if (!isNonEmptyString(ref)) {
        err('sources.ref-type', `${at} contains a non-string reference`);
        continue;
      }
      if (!SOURCE_LOCATOR_PATTERN.test(ref)) {
        err('sources.ref-format', `${at} reference "${ref}" is not a valid source locator (expected e.g. "S2" or "S2-p7-p5")`);
        continue;
      }
      const base = ref.split('-')[0];
      if (!sourceIds.has(base)) {
        err('sources.ref-unknown', `${at} references unknown source "${base}"`);
        continue;
      }
      // A page locator must be one-based and arithmetically consistent with the
      // source's verified printedPage -> PDF page offset.
      const m = ref.match(/^S[0-9]+-p([0-9]+)-p([0-9]+)$/);
      if (!m) continue;
      const pdfPage = Number(m[1]);
      const printedPage = Number(m[2]);
      if (pdfPage < 1 || printedPage < 1) {
        err('sources.locator-zero', `${at} reference "${ref}" uses a zero page number; PDF and printed pages are one-based`);
        continue;
      }
      const declaredOffset = sourcePageOffset.get(base);
      if (declaredOffset === undefined) {
        warn('sources.locator-unverifiable', `${at} reference "${ref}" cites two page numbers but source "${base}" declares no verified pageOffset, so the pair cannot be checked`);
      } else if (pdfPage - printedPage !== declaredOffset) {
        err('sources.locator-offset', `${at} reference "${ref}" implies an offset of ${pdfPage - printedPage} but source "${base}" declares printedPage + ${declaredOffset} = PDF page`);
      }
      const maxPages = sourcePageCount.get(base);
      if (isPositiveInteger(maxPages) && pdfPage > maxPages) {
        err('sources.locator-range', `${at} reference "${ref}" cites PDF page ${pdfPage} but source "${base}" has only ${maxPages} pages`);
      }
    }
  }
}

/* -------------------------------------------------------------------- CLI */
export function runCli(argv = process.argv.slice(2), io = console) {
  const target = argv.find((a) => !a.startsWith('-')) || DEFAULT_BLUEPRINT_PATH;
  const abs = path.resolve(target);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    io.error(`Cannot read blueprint: ${abs}\n  ${e.message}`);
    return 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    io.error(`Blueprint is not valid JSON: ${abs}\n  ${e.message}`);
    return 1;
  }
  const result = validateBlueprint(parsed);
  io.log(`exam-blueprint-check: ${abs}`);
  io.log(`  sections=${result.summary.sections} parts=${result.summary.parts} items=${result.summary.items} objectiveItems=1-${result.summary.objectiveItemsLast} writtenPoints=${result.summary.writtenPoints} minutes=${result.summary.totalMinutes}`);
  for (const w of result.warnings) io.log(`  WARN  ${w}`);
  for (const e of result.errors) io.error(`  ERROR ${e}`);
  if (result.ok) {
    io.log(`  OK    blueprint is internally consistent (${result.warnings.length} warning(s)).`);
    io.log('  NOTE  consistency is not exam validity and not approval.');
    return 0;
  }
  io.error(`  FAIL  ${result.errors.length} error(s).`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(runCli());
}

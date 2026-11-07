/**
 * PRACTICE-UI-01 (slice B) — the written examination's parts, as the package blueprint holds them.
 *
 * WHY THIS FILE EXISTS. Slice B's tiles need, per part: its item count and — for the hearing parts — the
 * playback rule. The server has both in `exam_blueprint.payload` (it already reads them to validate a form,
 * `server/owned-postgres/packages.mjs`), but no route ever served them. `/api/v1/objective-sets` cannot be
 * that route: it filters `s.media_required = false`, so HV1–HV3 are structurally absent from it. This module
 * is the pure half of the fix — normalise a blueprint payload into parts — and the adapter owns the read,
 * the admission gate and the transaction. No SQL here, no policy here, no connection here.
 *
 * READ-ONLY AND ADDITIVE. Nothing in this file writes or migrates. The existing parts array remains, and
 * `GET /api/v1/exam-parts` also exposes the selected blueprint's sections and timing groups.
 *
 * NO POINTS. The packaged blueprint carries `itemCount`, `interaction`, `mediaRequired` and `playback`, but
 * no per-part points (verified: no `points` key anywhere under `content/exams/telc-deutsch-b1/`). Per-part
 * points currently live in the client as a cited constant (contract amendment A6); if a later blueprint
 * revision carries them, `partPoints` below starts returning them and the route can grow a `points` member
 * without the client changing its reader. Until then this module must NOT invent one.
 */

import { validateTimeGroups } from './package-contract.mjs';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const nonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The playback rule the payload states for a part, or null.
 *
 * `practice` is the number of plays a practice attempt allows; `mock` is the examination rule. Both come
 * from the payload — `{practice: 1, mock: 1}` for HV1 and `{practice: 1, mock: 2}` for HV2 and HV3, which
 * is what `content/exams/telc-deutsch-b1/listening-package.json` declares and what
 * `docs/exam/TELC-B1-SOURCES.md` records for Teil 3 (every text is heard twice). REVIEW-PRACTICE-MEDIA F2
 * caught this comment claiming `HV3 mock: 1`, which both cited sources contradict.
 *
 * The tile renders the EXAM allowance (`mock`), not `practice`: Ron's decision 3 makes practice listening
 * follow the exam play rule, and the runner enforces and displays that number, so the tile must not say
 * one play while the server allows two (Lead decision on F2, recorded in amendment A10).
 */
export function partPlayback(part) {
  if (!isPlainObject(part?.playback)) return null;
  const practice = positiveInteger(part.playback.practice);
  if (!practice) return null;
  const mock = positiveInteger(part.playback.mock);
  return Object.freeze({ practice, mock: mock ?? null });
}

/** The per-part points, when a blueprint revision carries them. Today it does not; never invented. */
export function partPoints(part) {
  return positiveInteger(part?.points);
}

/**
 * Every part in the selected blueprint's section/part order. Family names are not exam identities.
 *
 * A malformed blueprint is a `TypeError`, not a silently short list: the caller turns it into a 503, because
 * "the package is corrupt" and "this exam has fewer parts" must not look the same to the client. Parts the
 * blueprint does not declare are simply absent from the result — the tile grid is "one tile per part with
 * released content", so an absent part is a part with nothing to show.
 */
export function blueprintParts(blueprint) {
  if (!isPlainObject(blueprint)) throw new TypeError('exam_blueprint_invalid');
  const sections = Array.isArray(blueprint.sections) ? blueprint.sections : null;
  if (!sections || !sections.length) throw new TypeError('exam_blueprint_invalid');
  const byFamily = new Map();
  const sectionIds = new Set();
  for (const section of sections) {
    const sectionId = nonEmptyString(section?.id);
    if (!sectionId || sectionIds.has(sectionId) || !Array.isArray(section.parts) || !section.parts.length) throw new TypeError('exam_blueprint_invalid');
    sectionIds.add(sectionId);
    const parts = section.parts;
    for (const part of parts) {
      const family = nonEmptyString(part?.family);
      const itemCount = positiveInteger(part?.itemCount);
      if (!family || !itemCount) throw new TypeError('exam_blueprint_invalid');
      if (byFamily.has(family)) throw new TypeError('exam_blueprint_invalid');
      byFamily.set(family, Object.freeze({
        family,
        section: sectionId,
        part: positiveInteger(part.part) ?? positiveInteger(Number(/^(?:LV|SB|HV|SA)([1-9][0-9]?)$/.exec(family)?.[1])),
        itemCount,
        interaction: nonEmptyString(part.interaction),
        mediaRequired: part.mediaRequired === true,
        playback: partPlayback(part),
        points: partPoints(part),
      }));
    }
  }
  return Object.freeze([...byFamily.values()]);
}

/** Non-content facts from one exact blueprint; absent points or schedules stay unknown. */
export function blueprintMetadata(blueprint) {
  const parts = blueprintParts(blueprint);
  try { validateTimeGroups(blueprint); }
  catch { throw new TypeError('exam_blueprint_invalid'); }
  return {
    sections: blueprint.sections.map(section => ({
      id: section.id,
      title: nonEmptyString(section.title),
      timeGroup: nonEmptyString(section.timeGroup),
      points: partPoints(section),
    })),
    time_groups: (blueprint.timeGroups ?? []).map(group => ({ id: group.id, seconds: group.seconds, sections: [...group.sections] })),
    parts,
  };
}

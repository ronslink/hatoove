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
 * READ-ONLY AND ADDITIVE. Nothing in this file writes, migrates or changes an existing response shape. It is
 * consulted only by `GET /api/v1/exam-parts`.
 *
 * NO POINTS. The packaged blueprint carries `itemCount`, `interaction`, `mediaRequired` and `playback`, but
 * no per-part points (verified: no `points` key anywhere under `content/exams/telc-deutsch-b1/`). Per-part
 * points currently live in the client as a cited constant (contract amendment A6); if a later blueprint
 * revision carries them, `partPoints` below starts returning them and the route can grow a `points` member
 * without the client changing its reader. Until then this module must NOT invent one.
 */

/** The eight written parts in examination order — the order the index renders. */
export const PART_ORDER = Object.freeze(['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const nonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The playback rule the payload states for a part, or null.
 *
 * `practice` is the number of plays a practice attempt allows; `mock` is the examination rule. Both come
 * from the payload — `{practice: 1, mock: 1}` for HV1/HV3 and `{practice: 1, mock: 2}` for HV2 in the
 * delivered telc package. The tile shows the PRACTICE allowance, because the tile leads to practice.
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
 * Every part of a blueprint payload, in `PART_ORDER`, as the route serves it.
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
  for (const section of sections) {
    const sectionId = nonEmptyString(section?.id);
    if (!sectionId) throw new TypeError('exam_blueprint_invalid');
    const parts = Array.isArray(section.parts) ? section.parts : [];
    for (const part of parts) {
      const family = nonEmptyString(part?.family);
      const itemCount = positiveInteger(part?.itemCount);
      if (!family || !itemCount) throw new TypeError('exam_blueprint_invalid');
      if (byFamily.has(family)) throw new TypeError('exam_blueprint_invalid');
      byFamily.set(family, Object.freeze({
        family,
        section: sectionId,
        part: positiveInteger(part.part) ?? null,
        itemCount,
        mediaRequired: part.mediaRequired === true,
        playback: partPlayback(part),
        points: partPoints(part),
      }));
    }
  }
  const ordered = PART_ORDER.filter((family) => byFamily.has(family)).map((family) => byFamily.get(family));
  const rest = [...byFamily.values()]
    .filter((part) => !PART_ORDER.includes(part.family))
    .sort((a, b) => a.family.localeCompare(b.family));
  return Object.freeze([...ordered, ...rest]);
}

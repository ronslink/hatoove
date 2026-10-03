/**
 * EXAM-S1 — the preparation contract, shared by the route, the PostgreSQL port and the checks.
 *
 * A preparation is one learner preparing for one exam package. The route validates shapes here; the port
 * enforces ownership, revisions and the one-active-per-exam rule; migration 0023 enforces the same rules in
 * SQL so the API is not the only guard.
 *
 * WHICH PACKAGES ARE OFFERED IS SERVER CONFIGURATION. S1 offers telc Deutsch B1 only. Adding an
 * `exam_package` row does not publish it: a package is offered only when it is in this list. A disposable
 * test may inject a second synthetic package through `createExamCatalogue({ enabled })` on the server side;
 * there is no request parameter, client flag or environment switch that widens it.
 */

// Circular with owned-api.mjs on purpose and safely: `Fault` is only used inside functions.
import { Fault } from './owned-api.mjs';

/** The package every existing and newly registered account prepares for in S1. */
export const INITIAL_EXAM_ID = 'telc-deutsch-b1';
/** The packages S1 offers. Frozen: widening it is a reviewed code change, not a setting. */
export const ENABLED_EXAM_IDS = Object.freeze([INITIAL_EXAM_ID]);

export const PREPARATION_STATES = Object.freeze(['active', 'archived']);
export const EXAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const fault = (status, code) => { throw new Fault(status, code); };

/**
 * The server-side package allowlist. `enabled` is for disposable tests only and is never read from a
 * request; the default is exactly `ENABLED_EXAM_IDS`.
 */
export function createExamCatalogue({ enabled = ENABLED_EXAM_IDS } = {}) {
  const ids = Object.freeze([...new Set(enabled)].filter((id) => typeof id === 'string' && EXAM_ID_RE.test(id)));
  return Object.freeze({
    ids,
    isEnabled: (examId) => ids.includes(examId),
  });
}

/** A real calendar date `YYYY-MM-DD`, or null. `2026-02-30` is refused, not rolled over. */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `preparationId` from a query string or a JSON body. Missing is `preparation_required`. */
export function requirePreparationId(value) {
  if (value === undefined || value === null || value === '') fault(422, 'preparation_required');
  if (typeof value !== 'string' || !UUID_RE.test(value)) fault(422, 'invalid_preparation');
  return value.toLowerCase();
}

/** `POST /api/v1/preparations` body. */
export function validateCreatePreparation(body) {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'examId')) fault(422, 'unknown_field');
  if (typeof body.examId !== 'string' || !EXAM_ID_RE.test(body.examId)) fault(422, 'invalid_exam');
  return { examId: body.examId };
}

/**
 * `PUT /api/v1/preparations/:id` body. `examDate: null` clears the date; `state` moves between active and
 * archived. Exam identity is not editable: an `examId` field is refused as unknown.
 */
export function validateUpdatePreparation(body) {
  const keys = Object.keys(body);
  if (keys.some((key) => !['expectedRevision', 'examDate', 'state'].includes(key))) fault(422, 'unknown_field');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) fault(422, 'invalid_preparation_update');
  const patch = {};
  if (body.examDate !== undefined) {
    if (body.examDate !== null && !isCalendarDate(body.examDate)) fault(422, 'invalid_exam_date');
    patch.examDate = body.examDate;
  }
  if (body.state !== undefined) {
    if (!PREPARATION_STATES.includes(body.state)) fault(422, 'invalid_preparation_update');
    patch.state = body.state;
  }
  if (!Object.keys(patch).length) fault(422, 'invalid_preparation_update');
  return { expectedRevision: body.expectedRevision, patch };
}

/** A date column (Date or string) as `YYYY-MM-DD`, without a timezone shift. */
export function dateOnly(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${String(value.getFullYear()).padStart(4, '0')}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

/** The frozen DTO. Nothing else leaves: no owner id, no legacy disposition. */
export function preparationDto(row) {
  return {
    id: row.id,
    exam_id: row.exam_id,
    exam: row.exam,
    exam_language: row.exam_language,
    exam_date: dateOnly(row.exam_date),
    state: row.state,
    revision: Number(row.revision),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

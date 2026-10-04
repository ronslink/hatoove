/**
 * Checks for the owned attempts API (OWNAPI-01, contract 0.1.0).
 *
 * What this proves
 *   * Shapes: the REAL public/js/owned-client.js is driven against
 *     server/owned-api.mjs through a fake fetchImpl that routes into the handler,
 *     with a per-browser cookie jar. A shape the client rejects shows up here as
 *     `malformed_response`, not as a hand-rolled assertion that merely resembles it.
 *   * Ownership, revisions, idempotency, immutability, the error contract and
 *     fail-closed wiring, each produced by a real request.
 *   * The server.js mount (when present) sits behind the SEC-01 origin gate: a
 *     second pass starts server.js in-process on an ephemeral loopback port.
 *
 * What this does NOT prove (default `memory` backend)
 *   * Anything about PostgreSQL. In the default mode the datastore below is IN MEMORY
 *     and test-only. Run with `--backend=postgres` (OWNAPI-02) to drive the same
 *     checks through server/owned-postgres as a restricted role with FORCE ROW
 *     LEVEL SECURITY; that mode needs the package installed and a disposable
 *     database. In memory, ownership scoping lives in the in-memory store's
 *     `ownedAttempt`/`ownedSubmission` helpers, which the discrimination run in
 *     work/implementation/OWNAPI-01.md disables to show the suite fails.
 *   * Real auth. The session port is a synthetic fake (in memory) or a
 *     synthetic PostgreSQL-backed port (postgres). Neither is Better Auth.
 *   * Browser behaviour. No browser is started.
 *
 * Safety: offline by default; no database, no provider, no `.env`; the server.js
 * pass points B1PREP_ENV_FILE / B1PREP_PROGRESS_FILE at a throwaway temp directory.
 *
 * Usage:
 *   node tools/owned-api-check.mjs                     (memory; exit 0 when every check passes)
 *   node tools/owned-api-check.mjs --backend=postgres  (real PostgreSQL + FORCE RLS)
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { createOwnedApi, Fault, CONTRACT_VERSION, ACCESS_REQUEST_CONSENT_VERSION } from '../server/owned-api.mjs';
import { stubGrade } from '../server/owned-postgres/worker.mjs';
import { THROTTLE_POLICY, throttleKeepSeconds, sweepCannotCutWindowShort, SUPERSEDED_KEEP_SECONDS } from '../server/owned-postgres/throttle.mjs';
import { createOwnedClient, OwnedClientError } from '../public/js/owned-client.js';
import {
  DEFAULT_TASK_BINDING, WRITING_TASKS, WRITING_RUBRIC, taskBindings,
  FORMATIVE_WRITING_RUBRIC, TELC_B1_WRITING_RUBRIC, TELC_B1_TASK_VERSION, CONTENT_VERSION,
} from '../server/owned-postgres/content-seed.mjs';
import { createExamCatalogue, preparationDto, INITIAL_EXAM_ID } from '../server/preparation-contract.mjs';

/* ================================================== in-memory ports (TEST ONLY) */

/**
 * The exam packages the memory datastore knows, standing in for the `exam_package` table. A package is
 * OFFERED only when it is also in the server-side catalogue (`createExamCatalogue`), exactly as in SQL.
 */
export const MEMORY_EXAM_PACKAGES = Object.freeze({
  [INITIAL_EXAM_ID]: Object.freeze({ exam_id: INITIAL_EXAM_ID, exam: 'telc Deutsch B1', exam_language: 'de', level: 'B1' }),
});

/**
 * In-memory datastore mirroring spikes/auth-runtime/store.mjs semantics.
 * Test-only: it has no durability, no RLS and no roles. Each method runs without
 * an await, so it is atomic within one event-loop turn, standing in for the
 * spike's single transaction.
 *
 * EXAM-S1: preparations and (owner, exam) balances, mirroring `server/owned-postgres/preparations.mjs` and
 * `adapter.mjs`. An absent balance reads as ZERO and reading never creates one. The ONLY writers of a
 * balance are `provision()` (registration, like `provision_learner`: insert-only, never a refill) and the
 * reservation/settlement paths. `allowance` is the default `provision()` grant, not a read-time default.
 *
 * For a standalone consumer: `const store = createMemoryDatastore();` then either
 * `createMemorySessions({ provision: store.provision })` (sign-up provisions an active telc preparation and
 * balance, as PostgreSQL does) or `const preparationId = store.provision(ownerId)` explicitly.
 */
export function createMemoryDatastore({
  allowance = 10, examCatalogue = createExamCatalogue(), examPackages = MEMORY_EXAM_PACKAGES,
} = {}) {
  const attempts = new Map();
  const drafts = new Map();
  const submissions = new Map();
  const events = new Map();
  const jobs = new Map();
  const assessments = new Map();
  const entitlements = new Map();
  const preparations = new Map();
  const calls = [];

  const fail = (status, code) => { throw new Fault(status, code); };
  const balanceKey = (owner, examId) => `${owner}\u0000${examId}`;
  // Reading a balance never creates one, so a rejected request leaves no trace. Absent is zero.
  const entitlement = (owner, examId = INITIAL_EXAM_ID) => entitlements.get(balanceKey(owner, examId)) ?? null;
  const adjust = (owner, examId, { used = 0, reserved = 0 }) => {
    const current = entitlement(owner, examId);
    if (!current) return; // a settlement against an absent balance changes nothing (SQL: UPDATE of no row)
    entitlements.set(balanceKey(owner, examId), { ...current, used: current.used + used, reserved: current.reserved + reserved });
  };
  const now = () => new Date().toISOString();
  const prepDto = (prep) => preparationDto({ ...prep, ...examPackages[prep.exam_id] });
  // Another owner's preparation is indistinguishable from an absent one.
  const ownedPreparation = (owner, id) => {
    const prep = preparations.get(id);
    if (!prep || prep.owner_id !== owner) fail(404, 'not_found');
    return prep;
  };
  const requirePreparationContext = (id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail(422, 'preparation_required');
    return id;
  };
  const requireActivePreparation = (owner, id) => {
    const prep = ownedPreparation(owner, id);
    if (prep.state !== 'active') fail(409, 'preparation_archived');
    return prep;
  };
  // EXAM-S1-D, as `requireEditableContext` in the adapter: a draft is edited only in its own active preparation.
  const requireEditableContext = (owner, attempt) => {
    if (!attempt.preparation_id) fail(422, 'preparation_unresolved');
    return requireActivePreparation(owner, attempt.preparation_id);
  };
  const activePreparation = (owner, examId) => [...preparations.values()]
    .find((p) => p.owner_id === owner && p.exam_id === examId && p.state === 'active');
  const insertPreparation = (owner, examId) => {
    const id = randomUUID();
    const at = now();
    preparations.set(id, { id, owner_id: owner, exam_id: examId, exam_date: null, state: 'active', revision: 1, created_at: at, updated_at: at });
    return preparations.get(id);
  };

  /**
   * EXPLICIT provisioning, the memory twin of `provision_learner`: an active preparation for `examId` (kept
   * if one exists) and, unless `grant` is null, a balance for (owner, exam) — INSERT-ONLY, an existing
   * balance is never refilled. Returns the active preparation id. Not reachable over HTTP.
   */
  const provision = (owner, { examId = INITIAL_EXAM_ID, grant = allowance } = {}) => {
    if (!examPackages[examId]) throw new Error(`unknown exam package: ${examId}`);
    const prep = activePreparation(owner, examId) ?? insertPreparation(owner, examId);
    if (grant !== null && !entitlements.has(balanceKey(owner, examId))) {
      entitlements.set(balanceKey(owner, examId), { allowance: grant, used: 0, reserved: 0 });
    }
    return prep.id;
  };
  // Ownership scoping. Another owner's record is indistinguishable from an absent one.
  const ownedAttempt = (owner, id) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.owner_id !== owner || attempt.deleted_at) fail(404, 'not_found');
    return attempt;
  };
  const ownedSubmission = (owner, id) => {
    const submission = submissions.get(id);
    if (!submission || submission.owner_id !== owner) fail(404, 'not_found');
    ownedAttempt(owner, submission.attempt_id);
    return submission;
  };
  const submissionFor = (attemptId) => [...submissions.values()].find((s) => s.attempt_id === attemptId);
  const attemptView = (attempt) => ({ ...attempt, ...drafts.get(attempt.id) });
  const bindingOf = (attempt) => ({ taskId: attempt.task_id, taskVersion: attempt.task_version,
    rubricId: attempt.rubric_id, rubricVersion: attempt.rubric_version });
  const historicalContent = (attempt) => {
    const task = WRITING_TASKS.find((row) => row.taskId === attempt.task_id);
    const rubric = [FORMATIVE_WRITING_RUBRIC, TELC_B1_WRITING_RUBRIC]
      .find((row) => row.rubricId === attempt.rubric_id && row.version === attempt.rubric_version);
    return {
      task: task ? { task_id: task.taskId, version: attempt.task_version, rubric_id: attempt.rubric_id,
        rubric_version: attempt.rubric_version, exam_id: 'telc-deutsch-b1', family: 'writing',
        register: task.register, topic: task.topic, situation: task.situation, adressat: task.adressat,
        leitpunkte: [...task.leitpunkte] } : null,
      rubric: rubric ? { rubric_id: rubric.rubricId, version: rubric.version, criteria: structuredClone(rubric.criteria),
        max_total: rubric.maxTotal, review_status: 'unreviewed', rights_status: 'generated', provisional: true } : null,
    };
  };
  const requireServableBinding = (binding, contentIsServable) => {
    if (!contentIsServable({ review_status: 'unreviewed', rights_status: 'generated' })
      || !taskBindings().some((row) => row.taskId === binding.taskId && row.version === binding.taskVersion
        && row.rubricId === binding.rubricId && row.rubricVersion === binding.rubricVersion)) fail(422, 'task_not_servable');
    // Every seeded writing task and rubric belongs to the initial package (content-seed.mjs).
    return INITIAL_EXAM_ID;
  };

  const port = {
    /*
     * EXAM-S1, in the adapter's order: a REVISION inherits its parent's exact preparation (an explicit
     * different one is 422 `preparation_mismatch`, an unresolved parent 422 `preparation_unresolved`); a new
     * attempt needs an owned (404), active (409) preparation whose exam matches the task's (422).
     */
    async create(owner, parent = null, binding = null, preparationId = null) {
      const { contentIsServable } = await import('../server/content-policy.mjs');
      calls.push('create');
      const parentRow = parent ? ownedSubmission(owner, parent) : null;
      let b = binding || DEFAULT_TASK_BINDING;
      let prepId = preparationId;
      if (parentRow) {
        const parentAttempt = ownedAttempt(owner, parentRow.attempt_id);
        const inherited = bindingOf(parentAttempt);
        if (binding && Object.keys(inherited).some((key) => binding[key] !== inherited[key])) fail(422, 'parent_binding_mismatch');
        if (!parentAttempt.preparation_id) fail(422, 'preparation_unresolved');
        if (preparationId && preparationId !== parentAttempt.preparation_id) fail(422, 'preparation_mismatch');
        prepId = parentAttempt.preparation_id;
        b = inherited;
      }
      requirePreparationContext(prepId);
      const prep = requireActivePreparation(owner, prepId);
      const contentExam = requireServableBinding(b, contentIsServable);
      if (contentExam !== prep.exam_id) fail(422, 'preparation_mismatch');
      const id = randomUUID();
      attempts.set(id, {
        id, owner_id: owner, task_id: b.taskId, task_version: b.taskVersion,
        rubric_id: b.rubricId, rubric_version: b.rubricVersion,
        parent_submission_id: parent, preparation_id: prep.id, exam_id: prep.exam_id,
        created_at: now(), deleted_at: null,
      });
      drafts.set(id, { revision: 1, text: parentRow?.text || '' });
      return { id, revision: 1, text: parentRow?.text || '',
        task_id: b.taskId, task_version: b.taskVersion, rubric_id: b.rubricId,
        rubric_version: b.rubricVersion, parent_submission_id: parent,
        preparation_id: prep.id, exam_id: prep.exam_id };
    },
    async read(owner, id) {
      calls.push('read');
      const attempt = ownedAttempt(owner, id);
      return { ...attemptView(attempt), ...historicalContent(attempt) };
    },
    // EXAM-S1: one preparation's history; there is no all-preparations default.
    async listAttempts(owner, { preparationId } = {}) {
      calls.push('listAttempts');
      requirePreparationContext(preparationId);
      ownedPreparation(owner, preparationId);
      return [...attempts.values()]
        .filter((a) => a.owner_id === owner && a.preparation_id === preparationId && !a.deleted_at)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
        .map((a) => {
          const s = submissionFor(a.id);
          return { id: a.id, task_id: a.task_id, task_version: a.task_version, rubric_id: a.rubric_id,
            rubric_version: a.rubric_version, preparation_id: a.preparation_id, exam_id: a.exam_id,
            parent_submission_id: a.parent_submission_id,
            revision: drafts.get(a.id)?.revision, created_at: a.created_at,
            topic: WRITING_TASKS.find((task) => task.taskId === a.task_id)?.topic, submission_id: s?.id ?? null,
            status: !s ? 'draft' : assessments.has(s.id) ? 'assessed'
              : ['failed', 'cancelled'].includes(jobs.get(s.id)?.status) ? 'unassessed' : 'pending' };
        });
    },
    // Mirrors the adapter: live attempts with drafts, and EVERY retained submission/result of the owner,
    // tombstoned history included and flagged by `attempt_deleted_at`.
    async exportData(owner) {
      calls.push('exportData');
      const active = [...attempts.values()].filter((a) => a.owner_id === owner && !a.deleted_at);
      const ownSubmissions = [...submissions.values()].filter((s) => s.owner_id === owner
        && attempts.get(s.attempt_id)?.owner_id === owner);
      const deletedAt = (s) => attempts.get(s.attempt_id).deleted_at ?? null;
      const context = (s) => ({ preparation_id: attempts.get(s.attempt_id).preparation_id ?? null,
        exam_id: attempts.get(s.attempt_id).exam_id ?? null });
      return {
        // EXAM-S1: every preparation (archived included) and every exam balance, as the adapter exports them.
        preparations: [...preparations.values()].filter((p) => p.owner_id === owner)
          .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || x.id.localeCompare(y.id))
          .map((p) => ({ ...prepDto(p), legacy_exam_date_disposition: null })),
        balances: [...entitlements.entries()].filter(([key]) => key.startsWith(`${owner}\u0000`))
          .map(([key, b]) => ({ exam_id: key.slice(owner.length + 1), ...b }))
          .sort((x, y) => x.exam_id.localeCompare(y.exam_id)),
        attempts: active.map(({ owner_id, deleted_at, ...a }) => ({ ...a, ...drafts.get(a.id) })),
        submissions: ownSubmissions.map(({ owner_id, event_id, ...s }) => ({ ...s,
          task_id: attempts.get(s.attempt_id).task_id, rubric_id: attempts.get(s.attempt_id).rubric_id,
          ...context(s), attempt_deleted_at: deletedAt(s) })),
        results: ownSubmissions.map((s) => {
          const { exam_id: creditExamId, ...job } = jobs.get(s.id);
          return { submission_id: s.id, ...job, credit_exam_id: creditExamId,
            ...structuredClone(assessments.get(s.id) || { feedback: null, model_version: null, prompt_version: null, rubric_version: null }),
            ...context(s), attempt_deleted_at: deletedAt(s) };
        }),
        objective_evidence: [],
      };
    },
    /*
     * THE SAME "OPEN" RULE AS THE POSTGRES ADAPTER, in the fixture that runs on the memory backend:
     * no submission exists, not deleted, newest first, and NO TEXT — the client reads the attempt it
     * decides to resume. A rule enforced in one backend and not the other is a test-only disagreement,
     * which is how a check passes here and fails there.
     */
    async listOpenAttempts(owner, { preparationId } = {}) {
      calls.push('listOpenAttempts');
      requirePreparationContext(preparationId);
      ownedPreparation(owner, preparationId);
      return [...attempts.values()]
        .filter((attempt) => attempt.owner_id === owner && attempt.preparation_id === preparationId
          && !attempt.deleted_at && !submissionFor(attempt.id))
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(y.id).localeCompare(String(x.id)))
        .map((attempt) => ({
          id: attempt.id,
          preparation_id: attempt.preparation_id,
          exam_id: attempt.exam_id,
          task_id: attempt.task_id,
          task_version: attempt.task_version,
          rubric_id: attempt.rubric_id,
          rubric_version: attempt.rubric_version,
          revision: drafts.get(attempt.id)?.revision ?? 1,
          created_at: attempt.created_at,
        }));
    },
    async save(owner, id, expectedRevision, text) {
      calls.push('save');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof text !== 'string' || text.length > 12000) {
        fail(422, 'invalid_draft');
      }
      const attempt = ownedAttempt(owner, id);
      const current = drafts.get(id);
      if (current.revision !== expectedRevision) fail(409, 'draft_conflict');
      if (submissionFor(id)) fail(409, 'revision_required');
      requireEditableContext(owner, attempt);
      const next = { revision: current.revision + 1, text };
      drafts.set(id, next);
      return { ...next };
    },
    async submit(owner, id, expectedRevision, eventId, explanationLanguage = 'de') {
      const { contentIsServable } = await import('../server/content-policy.mjs');
      calls.push('submit');
      const attempt = ownedAttempt(owner, id);
      // EXAM-S1: the attempt's OWN exam balance; absent is zero.
      const ent = attempt.exam_id ? entitlement(owner, attempt.exam_id) : null;
      const priorId = events.get(`${owner}\u0000${eventId}`);
      if (priorId) {
        const prior = submissions.get(priorId);
        if (prior.attempt_id !== attempt.id || prior.draft_revision !== expectedRevision) fail(409, 'idempotency_conflict');
        return { submissionId: prior.id, replay: true };
      }
      // An unresolved legacy attempt stays readable, but cannot spend a credit of a guessed exam.
      if (!attempt.preparation_id || !attempt.exam_id) fail(422, 'preparation_unresolved');
      requireActivePreparation(owner, attempt.preparation_id);
      requireServableBinding(bindingOf(attempt), contentIsServable);
      const draft = drafts.get(id);
      if (draft.revision !== expectedRevision) fail(409, 'draft_conflict');
      if (!draft.text.trim()) fail(422, 'empty_submission');
      if (submissionFor(id)) fail(409, 'already_submitted');
      if (!ent || ent.used + ent.reserved >= ent.allowance) fail(409, 'allowance_exhausted');
      const submissionId = randomUUID();
      // Frozen: stands in for the spike's trigger that rejects snapshot updates.
      submissions.set(submissionId, Object.freeze({
        id: submissionId, attempt_id: id, owner_id: owner, event_id: eventId, draft_revision: draft.revision,
        text: draft.text, task_version: attempt.task_version, rubric_version: attempt.rubric_version,
        explanation_language: explanationLanguage, created_at: new Date().toISOString(),
      }));
      events.set(`${owner}\u0000${eventId}`, submissionId);
      // `exam_id` is the balance this reservation lives in; every settlement uses it, never a later context.
      jobs.set(submissionId, { status: 'queued', failure_code: null, tries: 0, exam_id: attempt.exam_id });
      adjust(owner, attempt.exam_id, { reserved: 1 });
      return { submissionId, replay: false };
    },
    async result(owner, submissionId) {
      calls.push('result');
      const submission = ownedSubmission(owner, submissionId);
      const attempt = ownedAttempt(owner, submission.attempt_id);
      const job = jobs.get(submissionId);
      return {
        submission: { ...submission },
        job: { status: job.status, failure_code: job.failure_code, tries: job.tries },
        assessment: assessments.has(submissionId) ? structuredClone(assessments.get(submissionId)) : null,
        task_id: attempt.task_id, task_version: attempt.task_version, rubric_id: attempt.rubric_id,
        rubric_version: attempt.rubric_version, parent_submission_id: attempt.parent_submission_id,
        preparation_id: attempt.preparation_id ?? null, exam_id: attempt.exam_id ?? null,
        ...historicalContent(attempt),
      };
    },
    /*
     * Settles against the balance the job ORIGINALLY reserved from (`job.exam_id`). Allowed in an archived
     * preparation, as in the adapter: finishing pending work is not new practice.
     */
    async retry(owner, submissionId) {
      const { contentIsServable } = await import('../server/content-policy.mjs');
      calls.push('retry');
      const submission = ownedSubmission(owner, submissionId);
      const job = jobs.get(submissionId);
      const ent = entitlement(owner, job.exam_id);
      if (job.status !== 'failed' || job.tries >= 3 || job.failure_code === 'retry_exhausted') fail(409, 'retry_unavailable');
      requireServableBinding(bindingOf(ownedAttempt(owner, submission.attempt_id)), contentIsServable);
      if (!ent || ent.used + ent.reserved >= ent.allowance) fail(409, 'allowance_exhausted');
      job.status = 'queued';
      job.failure_code = null;
      adjust(owner, job.exam_id, { reserved: 1 });
    },
    // Only an unsubmitted draft can be discarded; ownership is proven first, so a foreign one stays 404.
    // EXAM-S1-D: discarding is an edit, so an archived or unresolved context refuses it as in the adapter.
    async remove(owner, id) {
      calls.push('remove');
      const attempt = ownedAttempt(owner, id);
      if (submissionFor(id)) fail(409, 'submitted_attempt');
      requireEditableContext(owner, attempt);
      attempt.deleted_at = new Date().toISOString();
      drafts.delete(id);
    },

    /*
     * EXAM-S1 — the preparation capability, mirroring `owned-postgres/preparations.mjs`. None of these
     * writes a balance: creating, archiving or resuming a preparation never grants or refills credits.
     */
    async listExams() {
      calls.push('listExams');
      return examCatalogue.ids.filter((id) => examPackages[id]).map((id) => ({ ...examPackages[id] }));
    },
    async listPreparations(owner) {
      calls.push('listPreparations');
      return [...preparations.values()].filter((p) => p.owner_id === owner)
        .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || x.id.localeCompare(y.id))
        .map(prepDto);
    },
    async readPreparation(owner, id) {
      calls.push('readPreparation');
      return prepDto(ownedPreparation(owner, id));
    },
    async resolvePreparation(owner, id) {
      calls.push('resolvePreparation');
      const prep = ownedPreparation(owner, id);
      return { id: prep.id, exam_id: prep.exam_id, state: prep.state };
    },
    async createPreparation(owner, examId) {
      calls.push('createPreparation');
      if (!examCatalogue.isEnabled(examId) || !examPackages[examId]) fail(422, 'exam_unavailable');
      const active = activePreparation(owner, examId);
      if (active) return { created: false, preparation: prepDto(active) };
      return { created: true, preparation: prepDto(insertPreparation(owner, examId)) };
    },
    async updatePreparation(owner, id, expectedRevision, patch) {
      calls.push('updatePreparation');
      const prep = ownedPreparation(owner, id);
      if (prep.revision !== expectedRevision) {
        const error = new Fault(409, 'preparation_conflict');
        error.current = prepDto(prep);
        throw error;
      }
      if (patch.state === 'active' && prep.state !== 'active'
        && [...preparations.values()].some((p) => p.id !== id && p.owner_id === owner && p.exam_id === prep.exam_id && p.state === 'active')) {
        fail(409, 'active_preparation_exists');
      }
      preparations.set(id, {
        ...prep,
        exam_date: patch.examDate !== undefined ? patch.examDate : prep.exam_date,
        state: patch.state ?? prep.state,
        revision: prep.revision + 1,
        updated_at: now(),
      });
      return prepDto(preparations.get(id));
    },
    async readCredits(owner, id) {
      calls.push('readCredits');
      const prep = ownedPreparation(owner, id);
      const b = entitlement(owner, prep.exam_id) ?? { allowance: 0, used: 0, reserved: 0 };
      return { examId: prep.exam_id, allowance: b.allowance, used: b.used, reserved: b.reserved,
        available: Math.max(0, b.allowance - b.used - b.reserved) };
    },
  };

  /** Worker-side test hooks. Not part of the HTTP port and never reachable over HTTP. */
  const worker = {
    claim(submissionId) {
      const job = jobs.get(submissionId);
      if (!job || job.status !== 'queued') return false;
      job.status = 'running';
      job.tries += 1;
      return true;
    },
    complete(submissionId, comment) {
      const job = jobs.get(submissionId);
      const submission = submissions.get(submissionId);
      if (!job || job.status !== 'running' || attempts.get(submission.attempt_id).deleted_at) return false;
      /*
       * THE CURRENT CONTRACT, produced by the same function the shipped grader uses. The memory fixture used
       * to write a one-comment `synthetic-formative` assessment; that stopped being the contract when the
       * writing rubric became telc B1's three-criterion one, and a fixture that fabricates a shape the
       * grader cannot produce is how a suite keeps asserting yesterday's contract. The `comment` argument is
       * still honoured for the RETIRED rubric, so a legacy attempt can be completed as what it is.
       */
      // `rubric_id` is on the ATTEMPT; the submission carries the VERSIONS it froze.
      const attemptRow = attempts.get(submission.attempt_id);
      const currentRubric = attemptRow.rubric_id === TELC_B1_WRITING_RUBRIC.rubricId
        && submission.rubric_version === TELC_B1_WRITING_RUBRIC.version;
      assessments.set(submissionId, Object.freeze({
        feedback: currentRubric
          ? stubGrade({ text: submission.text, explanationLanguage: submission.explanation_language }).feedback
          : { kind: 'synthetic-formative', comment },
        model_version: 'fixture-v1', prompt_version: 'fixture-v1', rubric_version: submission.rubric_version,
      }));
      adjust(submission.owner_id, job.exam_id, { reserved: -1, used: 1 });
      job.status = 'succeeded';
      return true;
    },
    fail(submissionId, code) {
      const job = jobs.get(submissionId);
      if (!job || job.status !== 'running') return false;
      job.status = 'failed';
      job.failure_code = code;
      adjust(submissions.get(submissionId).owner_id, job.exam_id, { reserved: -1 });
      return true;
    },
    /*
     * Reproduce a tombstone written by the RETIRED delete-anything `remove` (before
     * SUBMISSION-PRESERVE): such rows still exist in installed databases, so export and the late-worker
     * guard must keep handling them even though the API can no longer create one for a submitted attempt.
     */
    legacyTombstone(attemptId) {
      const attempt = attempts.get(attemptId);
      if (!attempt || attempt.deleted_at) return false;
      for (const submission of submissions.values()) {
        const job = submission.attempt_id === attemptId ? jobs.get(submission.id) : null;
        if (job && (job.status === 'queued' || job.status === 'running')) {
          job.status = 'cancelled';
          adjust(attempt.owner_id, job.exam_id, { reserved: -1 });
        }
      }
      attempt.deleted_at = new Date().toISOString();
      drafts.delete(attemptId);
      return true;
    },
  };

  const inspect = {
    calls,
    submissionCount: () => submissions.size,
    submission: (id) => submissions.get(id),
    job: (id) => ({ ...jobs.get(id) }),
    attempt: (id) => (attempts.has(id) ? { ...attempts.get(id), draft: drafts.get(id) ? { ...drafts.get(id) } : null } : null),
    /** One (owner, exam) balance, as the PostgreSQL fixture reports it: absent is zero, not the grant. */
    entitlement: (owner, examId = INITIAL_EXAM_ID) => ({
      owner_id: owner, exam_id: examId, ...(entitlement(owner, examId) ?? { allowance: 0, used: 0, reserved: 0 }),
    }),
    preparations: (owner) => [...preparations.values()].filter((p) => p.owner_id === owner).map((p) => ({ ...p })),
    fingerprint: () => JSON.stringify({
      attempts: [...attempts.values()], drafts: [...drafts.entries()], submissions: [...submissions.values()],
      jobs: [...jobs.entries()], assessments: [...assessments.entries()], entitlements: [...entitlements.entries()],
      preparations: [...preparations.values()],
    }),
  };

  /*
   * A SETTINGS PORT, so the settings contract is exercised on the MEMORY backend too. Without it the
   * route answers 503 `settings_unavailable` and every settings leg — including
   * `model-is-not-a-learner-setting`, which replaced the retired provider-config check — would either
   * have to be skipped here or could only run against PostgreSQL. A property asserted on one backend is
   * a property asserted on one backend.
   *
   * The stored shape mirrors the server's: a revision per owner and the learner-settable fields only.
   * `model` is deliberately absent — see SETTINGS_FIELDS in owned-api.mjs.
   */
  const settingsByOwner = new Map();
  const settingsDefaults = () => ({ examDate: '', dailyGoal: 20, theme: 'system', language: 'de' });
  const settingsPort = {
    async read(owner) {
      calls.push('settings.read');
      const stored = settingsByOwner.get(owner);
      return stored
        ? { revision: stored.revision, settings: { ...stored.settings } }
        : { revision: 0, settings: settingsDefaults() };
    },
    async write(owner, expectedRevision, patch) {
      calls.push('settings.write');
      const stored = settingsByOwner.get(owner) ?? { revision: 0, settings: settingsDefaults() };
      if (stored.revision !== expectedRevision) throw new Fault(409, 'settings_conflict', { current: { revision: stored.revision, settings: { ...stored.settings } } });
      const next = { revision: stored.revision + 1, settings: { ...stored.settings, ...patch } };
      settingsByOwner.set(owner, next);
      return { revision: next.revision, settings: { ...next.settings } };
    },
  };

  return { port, settings: settingsPort, worker, inspect, provision };
}

/**
 * In-memory session port. Synthetic accounts only; TEST ONLY, not an auth system.
 * @param {{provision?: (owner: string) => string}} [options] `provision` runs inside sign-up, standing in for
 *   `provision_learner` in the PostgreSQL registration transaction. Without it a new account has NO
 *   preparation and NO balance — never an implicit one.
 */
export function createMemorySessions({ provision = null } = {}) {
  const COOKIE = 'hatoove_owned_session';
  const users = new Map();
  const sessions = new Map();
  const hash = (password, salt) => scryptSync(password, salt, 32);
  const tokenFrom = (headers) => {
    const cookie = String(headers.cookie || '');
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return null;
  };
  const issue = (userId) => {
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, userId);
    return { setCookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` };
  };
  return {
    cookieName: COOKIE,
    liveSessions: () => sessions.size,
    async getSession(headers) {
      const userId = sessions.get(tokenFrom(headers));
      if (!userId) return null;
      const user = [...users.values()].find((u) => u.id === userId);
      return user ? { userId: user.id, email: user.email } : null;
    },
    async signUp({ email, password }) {
      if (users.has(email)) throw new Fault(422, 'user_exists');
      const salt = randomBytes(16);
      // Auth user ids are opaque text in contract 0.1.0, deliberately not UUIDs.
      const user = { id: `user-${randomBytes(9).toString('base64url')}`, email, salt, hash: hash(password, salt) };
      if (typeof provision === 'function') provision(user.id);
      users.set(email, user);
      return issue(user.id);
    },
    async signIn({ email, password }) {
      const user = users.get(email);
      if (!user || !timingSafeEqual(user.hash, hash(password, user.salt))) throw new Fault(401, 'invalid_credentials');
      return issue(user.id);
    },
    async signOut(headers) {
      sessions.delete(tokenFrom(headers));
      return { setCookie: `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
    },
  };
}

/**
 * In-memory account-request queue (migration `0041`; TEST ONLY).
 *
 * THE DUPLICATE RULE IS THE POINT OF THIS DOUBLE, so it is implemented as the product implements it rather
 * than as something convenient: the key is the FOLDED address, a second submission from the same address
 * KEEPS THE FIRST ROW (its `name`, its language, its consent version and its `created_at`), and the
 * returned `stored` flag is the only thing that differs. The route discards that flag, and the leg below
 * asserts the two responses are byte-identical — which is exactly what a test backend that answered
 * differently would break.
 */
export function createMemoryAccountRequests() {
  const rows = [];
  const find = (email) => rows.find((row) => row.email === email) || null;
  return {
    rows,
    /** Every stored row, oldest first, as the operator command would read it. */
    list: ({ status = null } = {}) => rows.filter((row) => status === null || row.status === status).map((row) => ({ ...row })),
    async submit({ name, email, language, consentVersion }) {
      // The address arrives already folded from the route; folding again here would hide a route that
      // forgot to, so this asserts the invariant instead of repairing it.
      assert.equal(email, email.toLowerCase(), 'the route must fold the address before it reaches the port');
      if (find(email)) return { stored: false };
      rows.push({
        id: `request-${randomBytes(8).toString('hex')}`,
        email, name, language, consent_version: consentVersion,
        status: 'open', created_at: new Date(), handled_at: null,
      });
      return { stored: true };
    },
    async decline(email) {
      const address = String(email).toLowerCase();
      const row = find(address);
      if (!row) return { found: false, declined: false };
      if (row.status !== 'open') return { found: true, declined: false };
      row.status = 'declined';
      row.handled_at = new Date();
      return { found: true, declined: true };
    },
    async purge({ email = null, olderThanDays = null } = {}) {
      const cutoff = olderThanDays === null ? null : Date.now() - olderThanDays * 86400000;
      const address = email === null ? null : String(email).toLowerCase();
      const kept = [];
      const removed = [];
      for (const row of rows) {
        const match = address !== null ? row.email === address : row.created_at.getTime() <= cutoff;
        (match ? removed : kept).push(row);
      }
      rows.length = 0;
      rows.push(...kept);
      return { removed: removed.length, emails: removed.map((row) => row.email) };
    },
  };
}

/* ============================================================ fake browsers */
function applySetCookie(jar, header) {
  if (!header) return;
  for (const line of Array.isArray(header) ? header : [header]) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * A same-origin "browser" talking to the handler in-process. `originChecked` is
 * true because the SEC-01 gate is proven separately against server.js below.
 */
function inProcessBrowser(api) {
  const jar = new Map();
  const log = [];
  const exchange = async ({ method, path: url, headers = {}, body, originChecked = true }) => {
    const sent = { ...headers };
    if (jar.size) sent.cookie = cookieHeader(jar);
    const response = await api.handle({ method, path: url, headers: sent, body, originChecked });
    applySetCookie(jar, response.headers['set-cookie']);
    log.push({ method, url, status: response.status, headers: response.headers });
    return response;
  };
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.credentials, 'same-origin', 'the client must send same-origin credentials');
    const response = await exchange({ method: init.method || 'GET', path: url, headers: init.headers, body: init.body });
    return { status: response.status, text: async () => response.body };
  };
  /** Raw request for inputs the real client refuses to send. */
  const raw = async (method, url, body, { headers, originChecked } = {}) => {
    const response = await exchange({
      method, path: url,
      body: typeof body === 'string' || body === undefined || body instanceof Uint8Array ? body : JSON.stringify(body),
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers },
      originChecked,
    });
    return { status: response.status, headers: response.headers, json: JSON.parse(response.body), text: response.body };
  };
  return { jar, log, fetchImpl, raw, client: createOwnedClient({ fetchImpl }) };
}

/** Real HTTP over node:http, with a browser-like Origin and cookie jar. */
function httpBrowser(port, { origin = `http://127.0.0.1:${port}` } = {}) {
  const jar = new Map();
  const request = ({ method, url, headers = {}, body }) => new Promise((resolve, reject) => {
    const sent = { host: `127.0.0.1:${port}`, ...headers };
    if (origin) sent.origin = origin;
    if (jar.size) sent.cookie = cookieHeader(jar);
    // As a browser does. node:http would otherwise send a DELETE body unframed.
    if (body !== undefined) sent['content-length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        applySetCookie(jar, res.headers['set-cookie']);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const fetchImpl = async (url, init = {}) => {
    const res = await request({ method: init.method || 'GET', url, headers: init.headers, body: init.body });
    return { status: res.status, text: async () => res.text };
  };
  return { jar, request, fetchImpl, client: createOwnedClient({ fetchImpl }) };
}

/* ================================================================ harness */

const ATTEMPT_ABSENT = '0f0f0f0f-0000-4000-8000-000000000000';
const SUBMISSION_ABSENT = '0e0e0e0e-0000-4000-8000-000000000000';
let emailCounter = 0;
/**
 * Unique per process. A durable installation (backend `postgres-persistent`) is never
 * dropped, so fixed addresses would collide on the second run and every sign-up would
 * fail with `user_exists`. The run id keeps repeated runs independent while the schema
 * and its rows persist - which is the property being proved.
 */
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const nextEmail = (tag) => `${tag}-${RUN_ID}-${++emailCounter}@example.invalid`;

/**
 * Selected datastore backend. `memory` is the original in-memory test double
 * (no persistence, no RLS). `postgres` swaps in the real adapter from
 * server/owned-postgres, which runs learner paths as a restricted role with
 * FORCE ROW LEVEL SECURITY. The checks below are otherwise untouched: the same
 * suite drives the same real client through the same real mount on both.
 */
let BACKEND = 'memory';
const openWorlds = [];

/*
 * A CATALOGUE FIXTURE, and a world that wires it — deliberately a SEPARATE world.
 *
 * The catalogue routes had no leg in this suite at all, which is how two routes the same client calls came
 * to enforce opposite family conventions without anything noticing. Wiring the catalogue into the shared
 * `world()` would change the behaviour every other leg sees (one of them asserts the 503 an UNWIRED
 * catalogue gives), so the catalogue gets its own world and only the legs that need it use it.
 *
 * The objective rows mirror the seeded shape exactly: `family` is the uppercase PART ID (`LV1`), `section`
 * is the group (`LV`), `part` is the integer, and `media_required` sets are filtered out by the adapter
 * because a listening set with no audio must not be offered.
 */
const OBJECTIVE_FIXTURE = Object.freeze([
  Object.freeze({ set_id: 'telc-deutsch-b1.lv1.01', version: 'v1', exam_id: 'telc-deutsch-b1', family: 'LV1', section: 'LV', part: 1, title: 'Wohnungen und WG-Zimmer', item_count: 6, media_required: false, review_status: 'unreviewed', rights_status: 'generated' }),
  Object.freeze({ set_id: 'telc-deutsch-b1.lv1.02', version: 'v1', exam_id: 'telc-deutsch-b1', family: 'LV1', section: 'LV', part: 1, title: 'Stellenanzeigen und Arbeitsuche', item_count: 6, media_required: false, review_status: 'unreviewed', rights_status: 'generated' }),
  Object.freeze({ set_id: 'telc-deutsch-b1.lv2.01', version: 'v1', exam_id: 'telc-deutsch-b1', family: 'LV2', section: 'LV', part: 2, title: 'Zeitungsartikel', item_count: 6, media_required: false, review_status: 'unreviewed', rights_status: 'generated' }),
  Object.freeze({ set_id: 'telc-deutsch-b1.sb1.01', version: 'v1', exam_id: 'telc-deutsch-b1', family: 'SB1', section: 'SB', part: 1, title: 'Formulare und Anzeigen', item_count: 6, media_required: false, review_status: 'unreviewed', rights_status: 'generated' }),
  Object.freeze({ set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', exam_id: 'telc-deutsch-b1', family: 'HV1', section: 'HV', part: 1, title: 'Nachrichten von Freunden', item_count: 6, media_required: true, review_status: 'unreviewed', rights_status: 'generated' }),
]);

function cataloguePort() {
  /*
   * BOTH task versions are served here on purpose. The catalogue really holds v1 bound to the RETIRED
   * four-criterion rubric and v2 bound to the current telc B1 rubric — re-binding an immutable catalogue
   * means new rows — so the fixture has to expose both for the "one card per task, the newest" rule to be
   * testable at all. The timestamps differ, because that is what decides.
   */
  const rows = [];
  for (const task of WRITING_TASKS) {
    rows.push({ ...task, version: CONTENT_VERSION, rubricId: FORMATIVE_WRITING_RUBRIC.rubricId, rubricVersion: FORMATIVE_WRITING_RUBRIC.version, createdAt: '2026-10-01T00:00:00Z' });
    rows.push({ ...task, version: TELC_B1_TASK_VERSION, rubricId: TELC_B1_WRITING_RUBRIC.rubricId, rubricVersion: TELC_B1_WRITING_RUBRIC.version, createdAt: '2026-10-02T00:00:00Z' });
  }
  return {
    async listTasks(owner, { examId = null, family = null } = {}) {
      return rows
        .filter((task) => (examId === null || examId === 'telc-deutsch-b1') && (family === null || family === 'writing'))
        .map((task) => ({
          task_id: task.taskId, version: task.version, exam_id: 'telc-deutsch-b1', family: 'writing',
          register: task.register, topic: task.topic, situation: task.situation, adressat: task.adressat,
          leitpunkte: task.leitpunkte, rubric_id: task.rubricId, rubric_version: task.rubricVersion,
          created_at: task.createdAt, review_status: 'unreviewed', rights_status: 'generated',
        }));
    },
    async listObjectiveSets(owner, { examId = null, family = null, group = null, part = null } = {}) {
      // The SAME filter the adapter applies, so a leg cannot pass on one backend and fail on the other:
      // an exact part id (family), a group prefix (section), an integer part, and media_required excluded.
      return OBJECTIVE_FIXTURE.filter((set) => (examId === null || set.exam_id === examId)
        && (family === null || set.family === family)
        && (group === null || set.section.startsWith(group))
        && (part === null || set.part === part)
        && set.media_required === false);
    },
    /* The rest of the catalogue is NOT exercised by this suite; they exist so the port counts as wired.
     * Their routes are covered where a real database is available (docker-stack-check, journey-api-check). */
    async readObjectiveSet() { return null; },
    /*
     * THE RUBRIC, from the same seed the migration writes. Both contracts are readable by version, which is
     * what lets an old attempt explain itself against the rubric it was graded under, and provisional is
     * derived from the content's review status exactly as the adapter derives it -- one source of truth for
     * the claim, so the two backends cannot disagree about whether the wording is settled.
     */
    async readRubric(owner, { rubricId, version } = {}) {
      const known = [
        { rubric: TELC_B1_WRITING_RUBRIC, reviewStatus: 'unreviewed' },
        { rubric: FORMATIVE_WRITING_RUBRIC, reviewStatus: 'unreviewed' },
      ].find((row) => row.rubric.rubricId === rubricId && row.rubric.version === version);
      if (!known) return null;
      return {
        rubric_id: known.rubric.rubricId,
        version: known.rubric.version,
        family: known.rubric.family || 'writing',
        exam_id: known.rubric.examId || 'telc-deutsch-b1',
        max_total: known.rubric.maxTotal || known.rubric.criteria.reduce((sum, c) => sum + c.max, 0),
        criteria: known.rubric.criteria,
        review_status: known.reviewStatus,
        rights_status: 'generated',
        provisional: known.reviewStatus !== 'approved',
      };
    },
    async listVocab() { return []; },
    async listNouns() { return []; },
    async listGuides() { return []; },
    async readGuide() { return null; },
  };
}

/** A world whose datastore ALSO implements the catalogue, so the two catalogue routes can be driven. */
async function catalogueWorld() {
  if (BACKEND !== 'memory') return world(); // the real datastore implements the catalogue already
  const store = createMemoryDatastore({ allowance: 10 });
  const sessions = createMemorySessions({ provision: store.provision });
  const api = createOwnedApi({ datastore: { ...store.port, ...cataloguePort() }, sessions, settings: store.settings });
  return { store, sessions, api, browser: () => inProcessBrowser(api) };
}

async function world({ allowance } = {}) {
  if (BACKEND === 'postgres') {
    const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
    const pg = await createPostgresWorld({ allowance });
    openWorlds.push(pg);
    // The throttle and the account-request queue are returned so a leg can use the SAME wiring the product
    // uses: `throttle` lets a persistent installation start from a clean budget, `accountRequests` is the
    // queue itself (the PostgreSQL port in this backend, the in-memory double in the next branch).
    return { store: pg.store, sessions: pg.sessions, api: pg.api, throttle: pg.throttle, accountRequests: pg.accountRequests, browser: () => inProcessBrowser(pg.api) };
  }
  if (BACKEND === 'postgres-persistent') {
    const pg = await persistentWorld({ allowance });
    openWorlds.push(pg);
    return { store: pg.store, sessions: pg.sessions, api: pg.api, throttle: pg.throttle, accountRequests: pg.accountRequests, browser: () => inProcessBrowser(pg.api) };
  }
  const store = createMemoryDatastore({ allowance });
  // Sign-up provisions the initial preparation and balance, as the PostgreSQL registration does.
  const sessions = createMemorySessions({ provision: store.provision });
  const accountRequests = createMemoryAccountRequests();
  const api = createOwnedApi({ datastore: store.port, sessions, settings: store.settings, accountRequests });
  return { store, sessions, api, accountRequests, browser: () => inProcessBrowser(api) };
}

/**
 * The SAME suite over a PERSISTENT installation (OWNAPI-03): real schema, real roles, provisioned from
 * reviewed SQL and never dropped. This is the deployment shape, as opposed to the disposable fixture above
 * that a checker can throw away.
 *
 * ONE WORLD PER LEG MEANS ONE SIGN-UP BUDGET PER LEG. The product's sign-up throttle is GLOBAL
 * (`signup:global`, THROTTLE_POLICY.signup) and lives in `auth_throttle`, a table the persistent schema
 * keeps. A disposable world starts with an empty table; a persistent world inherited every registration the
 * earlier legs (and earlier CI steps on the same database) had made, so after 30 the later legs failed at
 * synthetic sign-up with 429 — unrelated cases sharing one counter. Each persistent world therefore starts
 * its own window by clearing THAT ONE bucket through the product's own throttle port, exactly as a disposable
 * world does by being new. The throttle stays wired and enforcing with the shipped policy;
 * `tools/owned-api-throttle-isolation-check.mjs` proves both halves (a world still answers 429 past its
 * limit, and without this reset the next world inherits the exhaustion).
 *
 * Only for the persistent check backend, which `provisionPersistent` refuses without OWNAPI_PG_ALLOW on a
 * disposable database. Rate-limit counters only: no learner row is touched.
 *
 * @param {{allowance?: number, limits?: object|null, isolateSignupBudget?: boolean}} [options] `limits` is
 *   the fixture's injectable policy (small numbers so a check need not wait out a real window);
 *   `isolateSignupBudget: false` exists only for the discrimination leg.
 */
export async function persistentWorld({ allowance, limits = null, isolateSignupBudget = true } = {}) {
  const { provisionPersistent, closePersistent } = await import('../server/owned-postgres/provision.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const pools = await provisionPersistent();
  const fixture = {
    schema: pools.config.schema,
    roles: pools.config.roles,
    learner: pools.learner,
    auth: pools.auth,
    worker: pools.worker,
    admin: pools.admin,
    close: async () => { await closePersistent(pools); },
  };
  const pg = await createPostgresWorld({ allowance, fixture, ...(limits ? { limits } : {}) });
  assert.equal(pg.api.throttled, true, 'the persistent world must run with the auth throttle wired');
  if (isolateSignupBudget) await pg.throttle.clear('signup', SIGNUP_THROTTLE_KEY);
  return pg;
}

/** The one key the API counts every registration under (owned-api.mjs: `enforceThrottle('signup', 'global')`). */
export const SIGNUP_THROTTLE_KEY = 'global';

/** Tear down every PostgreSQL schema/role a `world()` opened. No-op in memory. */
async function closeWorlds() {
  for (const pg of openWorlds.splice(0)) await pg.teardown();
}

/**
 * EXAM-S1: the one ACTIVE telc preparation registration provisioned, read through the real
 * `GET /api/v1/preparations` route — never assumed, so a sign-up that provisioned nothing (or two) fails here.
 */
function activeInitialPreparation(list) {
  const active = (list && Array.isArray(list.preparations) ? list.preparations : [])
    .filter((p) => p.exam_id === INITIAL_EXAM_ID && p.state === 'active');
  assert.equal(active.length, 1, `registration must provision exactly one active ${INITIAL_EXAM_ID} preparation, got ${JSON.stringify(list)}`);
  return active[0].id;
}

async function learner(w, tag = 'a') {
  const b = w.browser();
  const account = await b.client.signUp({ name: `Learner ${tag}`, email: nextEmail(tag), password: `pw-${tag}-synthetic` });
  const preparationId = activeInitialPreparation((await b.raw('GET', '/api/v1/preparations')).json);
  return { ...b, account, preparationId };
}

async function expectClientError(promise, code, { status, detail } = {}) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof OwnedClientError, `expected OwnedClientError ${code}, got ${error ? error.stack || error : 'success'}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
  if (status !== undefined) assert.equal(error.status, status);
  if (detail !== undefined) assert.equal(error.detail, detail);
  return error;
}

/** A learner with one submitted attempt. */
async function submitted(w, tag = 'a', text = 'Liebe Anna, ich komme gern am Samstag.') {
  const who = await learner(w, tag);
  const attempt = await who.client.createAttempt({ preparationId: who.preparationId });
  const draft = await who.client.saveDraft(attempt.id, { expectedRevision: 1, text });
  const eventId = randomUUID();
  const receipt = await who.client.submit(attempt.id, { expectedRevision: draft.revision, eventId });
  return { ...who, attempt, draft, eventId, receipt };
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ----------------------------------------------------------- account/auth */

check('client-signup-establishes-verified-account', async () => {
  const w = await world();
  const a = await learner(w);
  assert.equal(a.account.contractVersion, CONTRACT_VERSION);
  assert.match(a.account.id, /^user-/, 'opaque text user id from the session port');
  assert.match(a.account.email, /@example\.invalid$/);
  assert.deepEqual(a.client.getAccount(), a.account);
  const account = await a.raw('GET', '/api/v1/account');
  assert.deepEqual(Object.keys(account.json).sort(), ['contractVersion', 'email', 'id']);
});

check('client-signin-and-wrong-password', async () => {
  const w = await world();
  const email = nextEmail('s');
  await w.browser().client.signUp({ name: 'S', email, password: 'right-synthetic' });
  const b = w.browser();
  await expectClientError(b.client.signIn({ email, password: 'wrong-synthetic' }), 'unauthenticated', { status: 401, detail: 'invalid_credentials' });
  assert.equal(b.client.getAccount(), null);
  const account = await b.client.signIn({ email, password: 'right-synthetic' });
  assert.equal(account.email, email);
});

/* ------------------------------------------- the pilot's public account request */

/*
 * THREE LEGS FOR ONE PUBLIC FORM (migration `0041`), and each one is about a thing this route must NOT do:
 * it must not tell anybody whether an address is already in the queue, it must not accept anything outside
 * the four fields it defines, and it must not answer "stored" when there is no queue to store into.
 */

check('pilot-account-request-is-stored-and-a-duplicate-is-byte-identical', async () => {
  const w = await world();
  const b = w.browser();
  const email = nextEmail('request');
  // A durable installation keeps every earlier run's rows and its own rate-limit counters, so this leg
  // starts from a known budget the way `persistentWorld` does for registration.
  if (w.throttle) {
    await w.throttle.clear('accessRequest', 'global');
    await w.throttle.clear('accessRequestEmail', email);
  }
  /*
   * THE QUEUE IS READ THROUGH ITS PORT, never through a backend-specific field: this leg has to mean the
   * same thing on the in-memory double and on PostgreSQL, and a `.rows` array that only one of them has is
   * how a check ends up proving something about the test double.
   */
  const before = (await w.accountRequests.list()).length;

  const first = await b.raw('POST', '/api/auth/request-access', { name: 'Anna Beispiel', email, language: 'de', consent: true });
  assert.equal(first.status, 202, `a public request is accepted: ${first.status} ${first.text}`);
  assert.deepEqual(first.json, { ok: true });
  // THE BODY NAMES NOTHING: no address, no name, no queue position, no "already there" flag.
  assert.equal(first.text, '{"ok":true}');
  // The page states one consent wording and the server records its version; they must be the same fact.
  assert.equal((await w.accountRequests.list())[0].consent_version, ACCESS_REQUEST_CONSENT_VERSION);

  /*
   * THE DUPLICATE. The same address, differently cased and with a different name and language, must
   * produce a response that is IDENTICAL BYTE FOR BYTE — not merely a similar status — and must leave the
   * first row untouched. Anything else turns a public form into a way to ask "is this address waiting for
   * an account?" about somebody else's address.
   */
  const stored = (await w.accountRequests.list())[0];
  const second = await b.raw('POST', '/api/auth/request-access',
    { name: 'Someone Else', email: email.toUpperCase(), language: 'tr', consent: true });
  assert.equal(second.status, first.status);
  assert.equal(second.text, first.text, 'a duplicate must answer byte-for-byte what a new address answers');
  assert.deepEqual(second.headers, first.headers, 'and with the same headers');
  const queue = await w.accountRequests.list();
  assert.equal(queue.length, before + 1, 'a duplicate must not create a second row');
  assert.deepEqual(queue[0], stored, 'the first request is left exactly as it was');

  // NO SESSION WAS EVER NEEDED, and none was created: this is the front door for people without an account.
  assert.equal(queue[0].email, email.toLowerCase(), 'the address is stored folded');
  assert.deepEqual([...b.jar.keys()], [], 'the request route sets no cookie');
});

check('pilot-account-request-refuses-everything-it-does-not-define', async () => {
  const w = await world();
  const b = w.browser();
  const email = nextEmail('request-refuse');
  if (w.throttle) await w.throttle.clear('accessRequest', 'global');
  const good = { name: 'Anna', email, language: 'de', consent: true };
  const cases = [
    // CONSENT IS THE BOOLEAN TRUTHY `true`, not a truthy value and not an omission.
    [{ ...good, consent: false }, 'invalid_consent'],
    [{ ...good, consent: 'true' }, 'invalid_consent'],
    [{ ...good, consent: 1 }, 'invalid_consent'],
    [{ name: good.name, email: good.email, language: good.language }, 'invalid_consent'],
    // LANGUAGE IS A CLOSED SET.
    [{ ...good, language: 'fr' }, 'invalid_language'],
    [{ ...good, language: 'DE' }, 'invalid_language'],
    [{ name: good.name, email: good.email, consent: true }, 'invalid_language'],
    // THE ADDRESS IS BOUNDED AND UNPADDED, by the one rule sign-up already uses.
    [{ ...good, email: 'not-an-address' }, 'invalid_email'],
    [{ ...good, email: ` ${email} ` }, 'invalid_email'],
    [{ ...good, email: `${'a'.repeat(250)}@example.invalid` }, 'invalid_email'],
    // THE NAME IS BOUNDED, NON-EMPTY AFTER TRIMMING, AND FREE OF CONTROL CHARACTERS (it is printed in an
    // operator's terminal by `server/access.mjs`).
    [{ ...good, name: '   ' }, 'invalid_name'],
    [{ ...good, name: 'x'.repeat(101) }, 'invalid_name'],
    [{ ...good, name: 'a\u0000b' }, 'invalid_name'],
    [{ name: good.name, email: good.email, language: 'de', consent: true, note: 'free text' }, 'unknown_field'],
    [{ ...good, ownerId: 'somebody-else' }, 'unknown_field'],
    [{ ...good, status: 'invited' }, 'unknown_field'],
  ];
  for (const [payload, code] of cases) {
    const res = await b.raw('POST', '/api/auth/request-access', payload);
    assert.equal(res.status, 422, `${JSON.stringify(payload)} -> ${res.status} ${res.text}`);
    assert.equal(res.json.error, code, `${JSON.stringify(payload)} -> ${res.json.error}`);
  }
  const rows = await w.accountRequests.list();
  assert.equal(rows.filter((row) => row.email === email.toLowerCase()).length, 0, 'a refused request stores nothing');
  // A GET on the same path is not a route: this is a store, never a read.
  const read = await b.raw('GET', '/api/auth/request-access');
  assert.equal(read.status, 404);
});

check('pilot-account-request-fails-closed-without-a-queue', async () => {
  /*
   * FAIL-CLOSED, unlike the throttle. A 202 that filed nothing would tell a person their request was
   * received when no row exists and nobody knows to answer — the one failure this route must never have.
   * (The equivalent 503 legs for settings, deletion and recovery live above; this is the same rule.)
   */
  const store = createMemoryDatastore({ allowance: 10 });
  const sessions = createMemorySessions({ provision: store.provision });
  const api = createOwnedApi({ datastore: store.port, sessions, settings: store.settings });
  assert.equal(api.requestsWired, false, 'without the port the API must say so');
  const b = inProcessBrowser(api);
  const res = await b.raw('POST', '/api/auth/request-access', { name: 'Anna', email: nextEmail('unwired'), language: 'de', consent: true });
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'requests_unavailable' });

  /*
   * AND THE PAGE ITSELF: the consent version the server records must be the wording the page shows, and
   * the box must arrive UNTICKED. A pre-ticked consent box is not consent, so it is asserted on the served
   * markup rather than trusted to a script.
   */
  const page = fs.readFileSync(path.resolve(fileURLToPath(import.meta.url), '..', '..', 'public', 'request-access.html'), 'utf8');
  assert.ok(page.includes(ACCESS_REQUEST_CONSENT_VERSION), 'the page must name the consent version the server records');
  assert.match(page, /id="request-consent"[^>]*\brequired\b/, 'the consent box is required');
  assert.doesNotMatch(page, /id="request-consent"[^>]*\bchecked\b/, 'the consent box must not be pre-ticked');
  assert.match(page, /data-i18n="auth\.requestConsent"/, 'the consent sentence is a translatable binding');
  assert.match(page, /hallo@hatoove\.com/, 'the page names the reply channel');
});

check('the throttle cleanup cannot cut a 24-hour window short', () => {
  /*
   * The account-request budgets are 24-hour windows, and the sweep bound used to be a fixed day — chosen
   * when the longest window was 90 minutes. Equal bounds mean the opportunistic cleanup reaches a counter
   * at the exact instant its window closes, which is a limit that sometimes forgets.
   *
   * THE NEGATIVE CONTROL IS THE OLD CONSTANT: it must NOT satisfy the rule any more, so reverting the
   * derivation turns this leg red instead of leaving a comment to be believed. This needs no database: it
   * is a property of the policy and the bound.
   */
  const longest = Math.max(...Object.values(THROTTLE_POLICY).map((rule) => rule.windowSeconds));
  assert.equal(longest, 86400, 'the account-request window is the longest in the shipped policy');
  assert.equal(sweepCannotCutWindowShort(THROTTLE_POLICY, SUPERSEDED_KEEP_SECONDS), false,
    'the superseded one-day bound must no longer satisfy the rule now that a window is a day long');
  assert.equal(sweepCannotCutWindowShort(THROTTLE_POLICY, throttleKeepSeconds(THROTTLE_POLICY)), true,
    'the derived bound must be strictly longer than every window in the policy');
  // A policy of short windows keeps at least the original day, so the table stays a picture of recent
  // attempts rather than a history of every address anyone typed.
  assert.equal(throttleKeepSeconds({ signin: { windowSeconds: 60 } }), 86400);
});

check('unauthenticated-requests-get-401', async () => {  const w = await world();
  const b = w.browser();
  assert.equal(await b.client.refreshAccount(), null, 'a 401 account reads as signed out');
  for (const [method, url, body] of [
    ['GET', '/api/v1/account'],
    ['POST', '/api/v1/attempts', {}],
    ['GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`],
    ['GET', `/api/v1/submissions/${SUBMISSION_ABSENT}`],
    ['GET', '/api/v1/no-such-route'],
    // EXAM-S1: preparation context is never readable or creatable without a session.
    ['GET', '/api/v1/preparations'],
    ['POST', '/api/v1/preparations', { examId: INITIAL_EXAM_ID }],
    ['GET', `/api/v1/attempts?open=1&preparationId=${ATTEMPT_ABSENT}`],
    ['POST', '/api/v1/attempts', { preparationId: ATTEMPT_ABSENT }],
  ]) {
    const res = await b.raw(method, url, body);
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'unauthenticated' });
  }
  assert.deepEqual(w.store.inspect.calls, [], 'no datastore method is reached without a session');
});

check('sign-out-invalidates-server-session', async () => {
  const w = await world();
  const a = await learner(w);
  const stolen = cookieHeader(a.jar);
  await a.client.signOut();
  assert.equal(a.client.getAccount(), null);
  assert.equal(a.jar.size, 0, 'the session cookie is cleared');
  const replay = await w.api.handle({ method: 'GET', path: '/api/v1/account', headers: { cookie: stolen } });
  assert.equal(replay.status, 401, 'the old session token no longer authenticates');
});

check('get-session-reports-only-the-verified-session', async () => {
  const w = await world();
  const a = await learner(w);
  const res = await a.raw('GET', '/api/auth/get-session');
  assert.deepEqual(res.json, { user: { id: a.account.id, email: a.account.email } });
  const anon = await w.browser().raw('GET', '/api/auth/get-session');
  assert.equal(anon.status, 200);
  assert.equal(anon.json, null);
});

/* -------------------------------------------------------------- lifecycle */

check('client-full-lifecycle-shapes', async () => {
  const w = await world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt({ preparationId: a.preparationId });
  assert.equal(attempt.revision, 1, 'draft revisions start at 1');
  assert.equal(attempt.text, '');
  assert.equal(attempt.preparation_id, a.preparationId, 'the attempt records the preparation it was created in');
  assert.equal(attempt.exam_id, INITIAL_EXAM_ID);
  const read = await a.client.readAttempt(attempt.id);
  assert.equal(read.id, attempt.id);
  assert.equal(read.owner_id, a.account.id);
  const saved = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'Hallo Anna' });
  assert.deepEqual(saved, { revision: 2, text: 'Hallo Anna' });
  const eventId = randomUUID();
  const receipt = await a.client.submit(attempt.id, { expectedRevision: 2, eventId });
  assert.equal(receipt.replay, false);
  const result = await a.client.readResult(receipt.submissionId);
  assert.equal(result.submission.text, 'Hallo Anna');
  assert.equal(result.submission.draft_revision, 2);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.assessment, null);
  // Uppercase ids are canonical UUIDs too; the handler normalises them.
  const upper = await a.client.readAttempt(attempt.id.toUpperCase());
  assert.equal(upper.id, attempt.id);
  // Every response on the owned surface is no-store.
  assert.ok(a.log.length >= 6);
  for (const entry of a.log) assert.equal(entry.headers['cache-control'], 'no-store', `${entry.method} ${entry.url}`);
});

check('draft-revision-checked-and-increments-once', async () => {
  const w = await world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt({ preparationId: a.preparationId });
  const r2 = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'eins' });
  const r3 = await a.client.saveDraft(attempt.id, { expectedRevision: 2, text: 'zwei' });
  assert.deepEqual([r2.revision, r3.revision], [2, 3]);
  const before = await w.store.inspect.fingerprint();
  await expectClientError(a.client.saveDraft(attempt.id, { expectedRevision: 2, text: 'veraltet' }), 'conflict', { status: 409, detail: 'draft_conflict' });
  await expectClientError(a.client.saveDraft(attempt.id, { expectedRevision: 9, text: 'Zukunft' }), 'conflict', { status: 409, detail: 'draft_conflict' });
  assert.equal(await w.store.inspect.fingerprint(), before, 'a stale save writes nothing');
  const current = await a.client.readAttempt(attempt.id);
  assert.deepEqual([current.revision, current.text], [3, 'zwei']);
});

check('submission-idempotent-on-owner-and-event', async () => {
  const w = await world();
  const s = await submitted(w);
  const again = await s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision, eventId: s.eventId });
  assert.deepEqual(again, { submissionId: s.receipt.submissionId, replay: true });
  assert.equal(await w.store.inspect.submissionCount(s.account.id), 1, 'no duplicate submission');
  assert.equal((await w.store.inspect.entitlement(s.account.id)).reserved, 1, 'reserved exactly once');
  // Same key, different fingerprint -> conflict.
  await expectClientError(s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision + 1, eventId: s.eventId }),
    'conflict', { status: 409, detail: 'idempotency_conflict' });
  // New key cannot resubmit the same frozen attempt.
  await expectClientError(s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision, eventId: randomUUID() }),
    'conflict', { status: 409, detail: 'already_submitted' });
  assert.equal(await w.store.inspect.submissionCount(s.account.id), 1);
  // The event key is per owner: another account reusing the same eventId gets its own submission.
  const b = await learner(w, 'b');
  const attemptB = await b.client.createAttempt({ preparationId: b.preparationId });
  await b.client.saveDraft(attemptB.id, { expectedRevision: 1, text: 'B Text' });
  const receiptB = await b.client.submit(attemptB.id, { expectedRevision: 2, eventId: s.eventId });
  assert.equal(receiptB.replay, false);
  assert.notEqual(receiptB.submissionId, s.receipt.submissionId);
});

check('submission-snapshot-immutable', async () => {
  const w = await world();
  const s = await submitted(w, 'a', 'Original eingereicht');
  await expectClientError(s.client.saveDraft(s.attempt.id, { expectedRevision: s.draft.revision, text: 'nachträglich' }),
    'conflict', { status: 409, detail: 'revision_required' });
  const record = await w.store.inspect.submission(s.receipt.submissionId);
  assert.throws(() => { record.text = 'changed'; }, TypeError, 'stored snapshot is frozen');
  const result = await s.client.readResult(s.receipt.submissionId);
  assert.equal(result.submission.text, 'Original eingereicht');
  assert.equal(result.submission.draft_revision, s.draft.revision);
  // Mutating a returned copy cannot reach the stored snapshot.
  result.submission.text = 'caller edit';
  assert.equal((await s.client.readResult(s.receipt.submissionId)).submission.text, 'Original eingereicht');
  // A new attempt linked to the submission is the only way to revise. EXAM-S1: it names no preparation and
  // INHERITS its parent's; naming a different one is refused and writes nothing.
  const before = await w.store.inspect.fingerprint();
  const elsewhere = await s.raw('POST', '/api/v1/attempts', { parentSubmissionId: s.receipt.submissionId, preparationId: randomUUID() });
  assert.equal(elsewhere.status, 422, `a revision in another preparation must be 422, got ${elsewhere.status}`);
  assert.equal(elsewhere.json.error, 'preparation_mismatch');
  assert.equal(await w.store.inspect.fingerprint(), before, 'the refused revision wrote nothing');
  const revision = await s.client.createAttempt({ parentSubmissionId: s.receipt.submissionId });
  assert.equal(revision.revision, 1);
  assert.equal(revision.preparation_id, s.preparationId, "a revision inherits its parent's preparation");
  assert.equal((await s.client.readAttempt(revision.id)).parent_submission_id, s.receipt.submissionId);
});

check('result-never-regrades', async () => {
  const w = await world();
  const s = await submitted(w);
  const id = s.receipt.submissionId;
  assert.ok(await w.store.worker.claim(id));
  assert.ok(await w.store.worker.complete(id, 'Synthetic formative note.'));
  const usageBefore = await w.store.inspect.entitlement(s.account.id);
  const fingerprint = await w.store.inspect.fingerprint();
  const reads = [];
  for (let i = 0; i < 3; i += 1) reads.push(await s.client.readResult(id));
  assert.equal(reads[0].job.status, 'succeeded');
  /*
   * THE BAND CONTRACT, READ BACK THREE TIMES. This assertion used to pin the one-comment shape; the contract
   * is now telc B1's three criteria with a band each, evidence quoted from the letter and corrections — and
   * it is asserted here as a SHAPE (kind, one band per criterion, no numbers) rather than as a fixed string,
   * because the bands depend on the learner's text and a frozen expectation would be asserting the fixture.
   */
  const feedback = reads[0].assessment.feedback;
  assert.equal(feedback.kind, 'telc-b1-bands', 'the result carries the band contract');
  assert.deepEqual(feedback.criteria.map((c) => c.key).sort(), TELC_B1_WRITING_RUBRIC.criteria.map((c) => c.key).sort());
  for (const criterion of feedback.criteria) {
    assert.ok(['A', 'B', 'C', 'D'].includes(criterion.band), `${criterion.key} band`);
    assert.ok(typeof criterion.comment === 'string' && criterion.comment.length > 0, `${criterion.key} comment`);
  }
  assert.ok(!JSON.stringify(feedback).match(/"(total|score|punkte)"\s*:/i), 'no numeric verdict may appear while R15 is open');
  assert.deepEqual(reads[1], reads[0]);
  assert.deepEqual(reads[2], reads[0]);
  assert.equal(await w.store.inspect.fingerprint(), fingerprint, 'reading a result writes nothing');
  assert.deepEqual(await w.store.inspect.entitlement(s.account.id), usageBefore, 'no new debit or reservation');
  // A succeeded job is not retryable, so a result cannot be regraded through retry either.
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
});

/*
 * THE MODEL IS NOT A LEARNER SETTING — the leg that replaced the retired provider-config check.
 *
 * `provider-config-check` guarded "a learner cannot set the provider or the model", and this ledger row
 * predicted that `model` was "still accepted today". It was: `SETTINGS_FIELDS` contained it on the
 * server AND in the shipped client, and `validateSettings` wrote it to the database. Nothing read it
 * back for provider selection — the provider's model comes from operator configuration — so it was a
 * field that only LOOKED like it controlled the model, settable from a browser by anyone with an
 * account.
 *
 * Both shapes are asserted refused, because the route accepts settings either nested or inline and a
 * fix that covered only one would leave the other open. The accepted fields are asserted to still
 * work in the same leg, so tightening the surface cannot be mistaken for disabling it.
 */
check('model-is-not-a-learner-setting', async () => {
  const w = await world();
  const s = await learner(w);
  const before = await s.client.readSettings();
  assert.ok(!('model' in before.settings), 'the server must not return a model field at all');
  /*
   * EVERY REJECTION PAYLOAD BELOW ALSO CARRIES A FIELD THAT IS LEGAL.
   *
   * That is the whole design of this leg, and the first version got it wrong: it sent
   * `{settings: {model}}` and asserted 422 — which is ALSO what a valid-but-empty patch gets, because
   * `validateSettings` refuses a patch that resolves to no fields at all. The assertion passed whether
   * or not `model` was accepted, for two different reasons, which is the "a check that cannot fail"
   * failure mode this programme keeps meeting. A payload whose only OTHER outcome is success makes
   * acceptance visible: if `model` were allowed, `{model, dailyGoal}` would be non-empty, the write would
   * land, and the 422 assertion would fail.
   *
   * EXAM-S1: the legal companion is `dailyGoal`, no longer `examDate` — the exam date belongs to the
   * preparation, and a settings write carrying it is itself refused (asserted at the end of this leg).
   */
  const legal = before.settings.dailyGoal === 37 ? 38 : 37;
  const nested = await s.raw('PUT', '/api/v1/settings', { expectedRevision: before.revision, settings: { model: 'gpt-4o', dailyGoal: legal } });
  assert.equal(nested.status, 422, `nested settings.model must be 422, got ${nested.status}`);
  const inline = await s.raw('PUT', '/api/v1/settings', { expectedRevision: before.revision, model: 'gpt-4o', dailyGoal: legal });
  assert.equal(inline.status, 422, `inline model must be 422, got ${inline.status}`);
  // The refusal is ATOMIC: the legal field travelling with the illegal one was not written either.
  const after = await s.client.readSettings();
  assert.equal(after.revision, before.revision, 'a refused write must not advance the revision');
  assert.notEqual(after.settings.dailyGoal, legal, 'a refused write must not store the field that travelled with it');
  // The shipped client refuses it locally too, which is defence in depth. `saveSettings` throws
  // SYNCHRONOUSLY for input it will not send, so this cannot use the promise-shaped helper.
  let clientRefusal = null;
  try {
    s.client.saveSettings({ expectedRevision: after.revision, settings: { model: 'gpt-4o', dailyGoal: legal } });
  } catch (error) {
    clientRefusal = error;
  }
  assert.ok(clientRefusal, 'the client must refuse a model setting rather than send it');
  assert.equal(clientRefusal.code, 'invalid_request', `client refusal code: ${clientRefusal.code}`);
  // The fields that ARE learner settings still work: tightening the surface is not disabling it.
  const saved = await s.client.saveSettings({ expectedRevision: after.revision, settings: { dailyGoal: legal, language: 'de' } });
  assert.equal(saved.revision, after.revision + 1, 'a real settings write still advances the revision once');
  assert.equal(saved.settings.dailyGoal, legal);
  assert.ok(!('model' in saved.settings), 'and no response grows a model field back');
  // The legacy exam date is read-only here: the server refuses it in both shapes and writes nothing.
  for (const body of [{ expectedRevision: saved.revision, examDate: '2026-12-12' },
    { expectedRevision: saved.revision, settings: { examDate: '2026-12-12' } }]) {
    assert.equal((await s.raw('PUT', '/api/v1/settings', body)).status, 422, `examDate is not a settings write: ${JSON.stringify(body)}`);
  }
  assert.equal((await s.client.readSettings()).revision, saved.revision, 'a refused examDate write must not advance the revision');
  return 'model refused by the client AND the server in both shapes (422) while a legal field in the same payload is left unwritten; dailyGoal/language still save; examDate refused as a settings write; no model in any response';
});

/*
 * AN ATTEMPT MUST BE BINDABLE TO THE TASK THE LEARNER OPENED — added before the route could do it.
 *
 * `POST /api/v1/attempts` took no binding at all: the datastore created every attempt against
 * `DEFAULT_TASK_BINDING`, so all six seeded writing prompts were unreachable as attempts and a writing
 * view could only ever have submitted against ONE task while showing another. That is the "the DOM was
 * correct and every class-name assertion passed" defect in a different costume — a screen that looks
 * right and a database row that belongs to something else.
 *
 * The refusal half matters as much as the acceptance half: a client must not be able to bind an attempt
 * to a task version the deployment does not serve, and it must not choose its own rubric. Both are
 * `422`, and both are asserted to leave NO attempt behind.
 */
check('attempt-binds-the-servable-task-the-learner-opened', async () => {
  const w = await world();
  const a = await learner(w);
  const servable = WRITING_TASKS[1];
  assert.ok(servable, 'the fixture needs at least two seeded writing tasks to tell them apart');
  /*
   * A DECLARED PAIR, said out loud: task `v2` (the version bound to the CURRENT rubric) with the telc B1
   * rubric. Pairing a task's v1 with the telc rubric is a tuple no catalogue row declares, and the datastore
   * refuses it — which is the rule this leg exists to prove, so the leg must not break it while setting up.
   */
  const binding = {
    taskId: servable.taskId,
    taskVersion: TELC_B1_TASK_VERSION,
    rubricId: TELC_B1_WRITING_RUBRIC.rubricId,
    rubricVersion: TELC_B1_WRITING_RUBRIC.version,
  };
  const attempt = await a.client.createAttempt({ ...binding, preparationId: a.preparationId });
  const read = await a.raw('GET', `/api/v1/attempts/${attempt.id}`);
  assert.equal(read.json.task_id, binding.taskId, 'the attempt must be bound to the task that was opened');
  assert.equal(read.json.task_version, binding.taskVersion, 'and to that VERSION, not to whichever is current');
  assert.equal(read.json.rubric_id, binding.rubricId, 'the rubric is the one the task declares');
  assert.notEqual(read.json.task_id, DEFAULT_TASK_BINDING.taskId, 'and not silently the default task');

  const before = await w.store.inspect.fingerprint();
  const scoped = { preparationId: a.preparationId };
  const unknown = await a.raw('POST', '/api/v1/attempts', { ...binding, ...scoped, taskId: 'writing.du.nicht-vorhanden' });
  assert.equal(unknown.status, 422, `a task the deployment does not serve must be 422, got ${unknown.status}`);
  assert.equal(unknown.json.error, 'task_not_servable', `refusal token: ${unknown.json.error}`);
  const wrongRubric = await a.raw('POST', '/api/v1/attempts', { ...binding, ...scoped, rubricId: 'writing.own-rubric' });
  assert.equal(wrongRubric.status, 422, `a client-chosen rubric must be refused, got ${wrongRubric.status}`);
  const incomplete = await a.raw('POST', '/api/v1/attempts', { ...scoped, taskId: binding.taskId });
  assert.equal(incomplete.status, 422, `a partial binding must be refused, got ${incomplete.status}`);
  assert.equal(incomplete.json.error, 'invalid_binding', `refusal token: ${incomplete.json.error}`);
  /*
   * EXAM-S1 — A NEW ATTEMPT NAMES ITS PREPARATION. Missing is never "telc by default", malformed is refused
   * before any lookup, and an id that is not this learner's is the same 404 as one that does not exist.
   */
  for (const [body, status, code] of [
    [binding, 422, 'preparation_required'],
    [{}, 422, 'preparation_required'],
    [{ ...binding, preparationId: 'not-a-uuid' }, 422, 'invalid_preparation'],
    [{ ...binding, preparationId: randomUUID() }, 404, 'not_found'],
  ]) {
    const res = await a.raw('POST', '/api/v1/attempts', body);
    assert.equal(res.status, status, `${JSON.stringify(body)} must be ${status}, got ${res.status}`);
    assert.equal(res.json.error, code, `refusal token: ${res.json.error}`);
  }
  assert.equal(await w.store.inspect.fingerprint(), before, 'no refused binding or context may leave an attempt behind');

  // Omitting the binding keeps the previous behaviour, so an existing caller does not break.
  const fallback = await a.client.createAttempt({ preparationId: a.preparationId });
  const fallbackRead = await a.raw('GET', `/api/v1/attempts/${fallback.id}`);
  assert.equal(fallbackRead.json.task_id, DEFAULT_TASK_BINDING.taskId, 'omitting the binding still uses the default task');
  return `bound to ${binding.taskId}@${binding.taskVersion}; unknown task, foreign rubric, partial binding and missing/invalid/absent preparation all refused with nothing written`;
});

/*
 * AN UNFINISHED LETTER MUST SURVIVE A RELOAD — `GET /api/v1/attempts?open=1`.
 *
 * The gap this closes was recorded, not guessed: a learner who reloads mid-letter got an empty textarea
 * and a NEW attempt, because nothing says "which attempt is open". The client keeps nothing in the browser
 * by design (`app-browser-check` L30 asserts exactly that), so the answer has to come from the server.
 *
 * Three properties, and the second one is the one that is easy to get wrong:
 *   * an attempt is RESUMABLE until a submission exists for it, and not afterwards — a submitted letter
 *     is a frozen snapshot, and resurrecting it as a draft would let a learner edit what was marked;
 *   * the index carries NO TEXT. A list that returned the draft body would ship a learner's letter in
 *     every poll of a list route, and the client does not need it: it reads the one attempt it resumes;
 *   * it is owner-scoped like every other read, and deleted attempts are not resumable.
 */
check('an-unfinished-attempt-is-resumable-and-a-submitted-one-is-not', async () => {
  const w = await world();
  const a = await learner(w, 'a');
  const b = await learner(w, 'b');
  // EXAM-S1: the index is one preparation's. Missing context is refused, never "every exam".
  const openOf = (who) => `/api/v1/attempts?open=1&preparationId=${who.preparationId}`;
  const none = (who) => ({ preparation_id: who.preparationId, attempts: [] });
  const unscoped = await a.raw('GET', '/api/v1/attempts?open=1');
  assert.equal(unscoped.status, 422, 'the open index without a preparation is refused');
  assert.equal(unscoped.json.error, 'preparation_required');

  // Nothing open to begin with: a fresh account has no draft to resume.
  assert.deepEqual((await a.raw('GET', openOf(a))).json, none(a), 'a fresh account has nothing to resume');
  /*
   * THE FLAG SELECTS A READ, IT DOES NOT OPEN THE PATH TO OTHER METHODS. A bare `GET /api/v1/attempts` is
   * no longer asserted 404: it becomes the supported history read, and `?open=1` stays the open index this
   * leg pins. What must stay `404 not_found` is a method this collection does not serve, flag or no flag.
   */
  for (const method of ['DELETE', 'PATCH']) {
    for (const url of ['/api/v1/attempts', '/api/v1/attempts?open=1']) {
      const res = await a.raw(method, url, {});
      assert.equal(res.status, 404, `${method} ${url} is not served`);
      assert.deepEqual(res.json, { error: 'not_found' });
    }
  }

  const attempt = await a.client.createAttempt({ preparationId: a.preparationId });
  const saved = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'Angefangener Brief' });
  const open = (await a.raw('GET', openOf(a))).json;
  assert.equal(open.attempts.length, 1, `exactly one open attempt expected, got ${open.attempts.length}`);
  const entry = open.attempts[0];
  assert.equal(entry.id, attempt.id, 'the open index names the attempt');
  assert.equal(entry.preparation_id, a.preparationId, 'and the preparation it belongs to');
  assert.equal(entry.revision, saved.revision, 'and the revision the client must save against');
  assert.equal(entry.task_id, DEFAULT_TASK_BINDING.taskId, 'and the task it is bound to, so the view can resume the RIGHT one');
  assert.equal(entry.task_version, DEFAULT_TASK_BINDING.taskVersion, 'including the version');
  // NO TEXT. The letter is read from the attempt itself, once the client has decided to resume it.
  assert.ok(!('text' in entry), 'the open index must not carry the draft text');
  assert.ok(!JSON.stringify(entry).includes('Angefangener Brief'), 'and no field may smuggle it');

  // Another learner sees none of it: not in their own preparation, and A's preparation is a plain 404.
  assert.deepEqual((await b.raw('GET', openOf(b))).json, none(b), 'the index is owner-scoped: a stranger sees nothing');
  for (const url of [openOf(a), `/api/v1/attempts?preparationId=${a.preparationId}`]) {
    const foreign = await b.raw('GET', url);
    assert.equal(foreign.status, 404, `another learner's preparation must be 404 on ${url}, got ${foreign.status}`);
    assert.deepEqual(foreign.json, { error: 'not_found' });
  }

  // Submitting ends resumability: the snapshot is frozen and must not come back as an editable draft.
  await a.client.submit(attempt.id, { expectedRevision: saved.revision, eventId: randomUUID() });
  assert.deepEqual((await a.raw('GET', openOf(a))).json, none(a),
    'a submitted attempt is not resumable');

  // A deleted attempt is not resumable either.
  const second = await a.client.createAttempt({ preparationId: a.preparationId });
  await a.client.saveDraft(second.id, { expectedRevision: 1, text: 'Wird verworfen' });
  assert.equal((await a.raw('GET', openOf(a))).json.attempts.length, 1, 'a second draft is open too');
  await a.client.deleteAttempt(second.id);
  const afterDelete = (await a.raw('GET', openOf(a))).json;
  assert.ok(!afterDelete.attempts.some((x) => x.id === second.id), 'a deleted attempt is not resumable');
  return `resumed ${entry.id}@rev${entry.revision} with no text in the index; empty for a stranger, after submit, and after delete`;
});

/*
 * FAMILY NAMING — ONE CONVENTION, ASSERTED ON BOTH CATALOGUE ROUTES.
 *
 * The measured defect (and `journey-api-check` leg J4, the only red leg in the only red CI job):
 * `/api/v1/tasks` accepted a lowercase KIND (`writing`) while `/api/v1/objective-sets` accepted an
 * uppercase PART ID (`HV1`) — two routes the same client calls, enforcing opposite conventions. J4 asks
 * the tasks route for `family=SA1`, the blueprint's writing part id, and gets 422.
 *
 * These legs assert the unification WITHOUT touching a stored row: both spellings are accepted, on both
 * routes, through ONE parser, and everything outside the closed set is still refused. The catalogue is
 * also exercised here for the FIRST time — neither route had a leg in this suite, which is how the
 * disagreement survived a programme with 30 legs around it.
 */
check('family-ids-are-one-convention-across-both-catalogue-routes', async () => {
  const w = await catalogueWorld();
  const a = await learner(w);
  // EXAM-S1: every catalogue read runs in the learner's own preparation.
  const scope = `&preparationId=${a.preparationId}`;

  // ONE PART ID, THE SAME ANSWER — and the kind token keeps working, because the app and
  // docker-stack-check both send it.
  const byPart = await a.raw('GET', `/api/v1/tasks?family=SA1${scope}`);
  const byKind = await a.raw('GET', `/api/v1/tasks?family=writing${scope}`);
  assert.equal(byPart.status, 200, `family=SA1 must be accepted, got ${byPart.status} ${byPart.text.slice(0, 80)}`);
  /*
   * CASE-SIGNIFICANT, and that is the point rather than pedantry: docker-stack-check already asserts that a
   * lowercase PART ID is refused rather than silently accepted, and accepting both casings would be two
   * conventions wearing one name — the defect this parser exists to end. The two forms are a PART ID and a
   * KIND, not a spelling and its variant.
   */
  assert.equal((await a.raw('GET', `/api/v1/tasks?family=sa1${scope}`)).status, 422, 'a lowercase part id must be refused');
  assert.deepEqual(byKind.json, byPart.json, 'the kind token must return the same tasks as its part id');
  assert.ok(Array.isArray(byPart.json) && byPart.json.length >= 1, 'and it must actually return the writing tasks');
  assert.ok(byPart.json.every((t) => t.family === 'writing'), 'all of them from the writing family');

  // AN OBJECTIVE PART ID ON THE TASKS ROUTE IS AN EMPTY ANSWER, NOT A REFUSAL: the route narrows, it does
  // not decide which parts exist. Refusing here is what made the two routes disagree.
  const lvOnTasks = await a.raw('GET', `/api/v1/tasks?family=LV1${scope}`);
  assert.equal(lvOnTasks.status, 200, `family=LV1 on the tasks route must narrow, not refuse, got ${lvOnTasks.status}`);
  assert.deepEqual(lvOnTasks.json, [], 'and there are no reading tasks in the writing catalogue');

  // THE OBJECTIVE ROUTE, BOTH FORMS: an exact part id and a group. The group form is what makes the two
  // routes speak one language — a KIND is a valid filter everywhere.
  const onePart = await a.raw('GET', `/api/v1/objective-sets?family=LV1${scope}`);
  assert.equal(onePart.status, 200, `family=LV1 must be accepted, got ${onePart.status}`);
  assert.ok(Array.isArray(onePart.json) && onePart.json.length >= 1, 'and must match the seeded LV1 sets');
  assert.ok(onePart.json.every((s) => s.family === 'LV1' && s.part === 1), 'only LV1, part 1');
  const group = await a.raw('GET', `/api/v1/objective-sets?family=lv${scope}`);
  assert.equal(group.status, 200, 'the group form must be accepted');
  assert.ok(group.json.length >= onePart.json.length, `the group must be at least as wide as one part (${group.json.length} vs ${onePart.json.length})`);
  assert.ok(group.json.every((s) => String(s.section).toUpperCase() === 'LV'), 'and every row must be Leseverstehen');
  const writingOnSets = await a.raw('GET', `/api/v1/objective-sets?family=SA1${scope}`);
  assert.equal(writingOnSets.status, 200, 'the writing part id is valid on this route too');
  assert.deepEqual(writingOnSets.json, [], 'and there are no objective sets in it');

  // THE CLOSED SET STILL CLOSES: a plausible but non-existent part, an unknown group and junk are all
  // refused on both routes. Accepting either SPELLING is not accepting anything.
  for (const bad of ['SA2', 'LV9', 'SB3', 'XX1', 'nonsense', 'LV1 ', '', 'sa1', 'WRITING']) {
    const res = await a.raw('GET', `/api/v1/tasks?family=${encodeURIComponent(bad)}${scope}`);
    assert.equal(res.status, 422, `tasks family=${JSON.stringify(bad)} must be 422, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_family', `tasks family=${JSON.stringify(bad)} token`);
    const sets = await a.raw('GET', `/api/v1/objective-sets?family=${encodeURIComponent(bad)}${scope}`);
    assert.equal(sets.status, 422, `objective-sets family=${JSON.stringify(bad)} must be 422, got ${sets.status}`);
  }
  return `SA1 and writing agree on the tasks route (${byPart.json.length} task(s)); LV1 exact + lv group on the sets route; 9 invalid spellings refused on both`;
});

check('the-catalogue-serves-the-telc-rubric-once-per-task', async () => {
  const w = await catalogueWorld();
  const a = await learner(w);

  const listed = await a.raw('GET', `/api/v1/tasks?family=SA1&preparationId=${a.preparationId}`);
  assert.equal(listed.status, 200, `the tasks route must answer, got ${listed.status}`);

  /*
   * THE D4/R11 CONTRACT, ON THE WIRE. Ron answered the rubric question on 2 October 2026: the writing
   * feedback follows telc B1's own marking structure. The catalogue is immutable, so the six prompts are
   * RE-BOUND at task v2 rather than edited — and every served task must therefore point at the current
   * rubric, never at the retired four-criterion one.
   */
  for (const task of listed.json) {
    assert.equal(task.rubric_id, TELC_B1_WRITING_RUBRIC.rubricId, `${task.task_id} must declare the current rubric`);
    assert.equal(task.rubric_version, TELC_B1_WRITING_RUBRIC.version, `${task.task_id} rubric version`);
    assert.notEqual(task.rubric_id, FORMATIVE_WRITING_RUBRIC.rubricId, 'the retired rubric must not be served for a new attempt');
  }

  /*
   * ONE CARD PER TASK — THE NEWEST VERSION. Both v1 (retired rubric) and v2 (current) are servable under the
   * pilot's policy, so without this rule a learner would see the same prompt twice and have to guess which
   * one to write into. The fixture serves BOTH versions on purpose; the route is what picks.
   */
  const ids = listed.json.map((task) => task.task_id);
  assert.equal(new Set(ids).size, ids.length, `the catalogue must not repeat a task (got ${ids.length} rows for ${new Set(ids).size} task(s))`);
  assert.equal(ids.length, WRITING_TASKS.length, `every seeded prompt is served exactly once (${ids.length})`);
  assert.ok(listed.json.every((task) => task.version === TELC_B1_TASK_VERSION), 'and the version served is the newest one');
  return `${ids.length} prompt(s), one version each, all declaring ${TELC_B1_WRITING_RUBRIC.rubricId}@${TELC_B1_WRITING_RUBRIC.version}`;
});

/*
 * THE RUBRIC IS READABLE, AND ITS WORDING IS PROVISIONAL.
 *
 * A band on its own is not feedback a learner can act on: "B" means nothing without knowing what B is.
 * The descriptors that explain each band live in the RUBRIC — one source of truth, written independently
 * for this product — so the screen must READ them rather than carry its own copy. A copy in the client is
 * the drift this programme keeps meeting: two texts, one of them stale, and no check able to tell.
 *
 * Two properties beyond "the route answers":
 *   * the provisional status travels WITH the text, so the screen cannot present unreviewed wording as
 *     settled — E-01 (a qualified reviewer against telc's current model exam) is still open;
 *   * the RETIRED rubric is readable BY ITS EXACT VERSION and returns its own four criteria. That is the
 *     "never renormalise" rule again: an old attempt's feedback can still explain itself against the
 *     contract it was graded under.
 */
check('the-rubric-is-readable-and-carries-its-own-provisional-status', async () => {
  const w = await catalogueWorld();
  const a = await learner(w);

  const current = await a.raw('GET', `/api/v1/rubrics/${TELC_B1_WRITING_RUBRIC.rubricId}?version=${TELC_B1_WRITING_RUBRIC.version}`);
  assert.equal(current.status, 200, `the rubric must be readable, got ${current.status} ${current.text.slice(0, 80)}`);
  const rubric = current.json;
  assert.equal(rubric.rubric_id, TELC_B1_WRITING_RUBRIC.rubricId);
  assert.equal(rubric.version, TELC_B1_WRITING_RUBRIC.version);
  assert.equal(rubric.criteria.length, 3, 'three criteria');
  for (const criterion of rubric.criteria) {
    assert.ok(typeof criterion.label === 'string' && criterion.label.length > 0, `${criterion.key}: a name`);
    assert.deepEqual(Object.keys(criterion.bands), ['A', 'B', 'C', 'D'], `${criterion.key}: the A-D scale`);
    for (const band of ['A', 'B', 'C', 'D']) {
      assert.ok(typeof criterion.descriptors?.[band] === 'string' && criterion.descriptors[band].length > 0,
        `${criterion.key}.${band}: a descriptor, because a band without one is not actionable`);
    }
  }
  // THE STATUS TRAVELS WITH THE TEXT. A screen cannot label what it was not told.
  assert.equal(rubric.review_status, 'unreviewed', 'the seeded status is unreviewed until E-01');
  assert.equal(rubric.provisional, true, 'and the wording is marked provisional');

  // The RETIRED contract, by its own version, unchanged and separate.
  const retired = await a.raw('GET', `/api/v1/rubrics/${FORMATIVE_WRITING_RUBRIC.rubricId}?version=${FORMATIVE_WRITING_RUBRIC.version}`);
  assert.equal(retired.status, 200, 'a retired rubric is still readable by its exact version');
  assert.equal(retired.json.criteria.length, 4, 'and it still has its four criteria');
  assert.notDeepEqual(retired.json.criteria.map((c) => c.key), rubric.criteria.map((c) => c.key),
    'the two contracts must not be presented as one');

  // Unknown ids and versions are 404, not an empty rubric: an unknown contract is not an answer.
  assert.equal((await a.raw('GET', '/api/v1/rubrics/writing.nope?version=v1')).status, 404);
  assert.equal((await a.raw('GET', `/api/v1/rubrics/${TELC_B1_WRITING_RUBRIC.rubricId}?version=v99`)).status, 404);
  return `${rubric.criteria.length} criteria with A-D descriptors and provisional=${rubric.provisional}; the retired contract readable by version with ${retired.json.criteria.length} criteria`;
});

check('retry-only-eligible-failed-job-same-identity', async () => {
  const w = await world();
  const s = await submitted(w);
  const id = s.receipt.submissionId;
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
  await w.store.worker.claim(id);
  await w.store.worker.fail(id, 'provider_unavailable');
  assert.deepEqual(await s.client.retry(id), { queued: true });
  const result = await s.client.readResult(id);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.submission.id, id, 'same submission identity');
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
  // retry_exhausted never retries.
  await w.store.worker.claim(id);
  await w.store.worker.fail(id, 'retry_exhausted');
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
});

check('allowance-exhausted-409', async () => {
  const w = await world({ allowance: 1 });
  const s = await submitted(w);
  const next = await s.client.createAttempt({ preparationId: s.preparationId });
  await s.client.saveDraft(next.id, { expectedRevision: 1, text: 'zweiter Text' });
  await expectClientError(s.client.submit(next.id, { expectedRevision: 2, eventId: randomUUID() }),
    'conflict', { status: 409, detail: 'allowance_exhausted' });
});

/*
 * DELETE DISCARDS A DRAFT; IT NEVER REMOVES SUBMITTED WORK (SUBMISSION-PRESERVE).
 *
 * This leg used to delete a SUBMITTED attempt and assert the job was cancelled and the reservation
 * released. That behaviour is retired: a stale draft view could cancel paid-for feedback and make
 * history disappear. A submitted attempt now answers 409 `submitted_attempt` and changes nothing;
 * the tombstone semantics are asserted on an attempt that was never submitted.
 */
check('delete-is-a-tombstone', async () => {
  const w = await world();
  const s = await submitted(w);
  const before = await w.store.inspect.fingerprint();
  await expectClientError(s.client.deleteAttempt(s.attempt.id), 'conflict', { status: 409, detail: 'submitted_attempt' });
  assert.equal(await w.store.inspect.fingerprint(), before, 'a refused delete changes nothing');
  assert.equal((await w.store.inspect.job(s.receipt.submissionId)).status, 'queued', 'the job is not cancelled');
  assert.equal((await w.store.inspect.entitlement(s.account.id)).reserved, 1, 'the reservation is kept');
  assert.equal((await s.client.readResult(s.receipt.submissionId)).submission.text, s.draft.text, 'the result stays readable');

  const draft = await s.client.createAttempt({ preparationId: s.preparationId });
  await s.client.saveDraft(draft.id, { expectedRevision: 1, text: 'verworfen' });
  assert.deepEqual(await s.client.deleteAttempt(draft.id), { deleted: true });
  assert.ok((await w.store.inspect.attempt(draft.id)).deleted_at, 'tombstone recorded');
  assert.equal((await w.store.inspect.attempt(draft.id)).draft, null, 'draft removed');
  assert.equal((await w.store.inspect.entitlement(s.account.id)).reserved, 1, 'discarding a draft touches no reservation');
  await expectClientError(s.client.readAttempt(draft.id), 'not_found', { status: 404 });
  await expectClientError(s.client.saveDraft(draft.id, { expectedRevision: 2, text: 'stale' }), 'not_found', { status: 404 });
  await expectClientError(s.client.submit(draft.id, { expectedRevision: 2, eventId: randomUUID() }), 'not_found', { status: 404 });
  await expectClientError(s.client.deleteAttempt(draft.id), 'not_found', { status: 404 });
});

check('archived-drafts-refuse-edits-until-explicit-resume', async () => {
  const w = await world();
  const a = await learner(w, 'archive');
  const draft = await a.client.createAttempt({ preparationId: a.preparationId });
  await a.client.saveDraft(draft.id, { expectedRevision: 1, text: 'vor dem Archiv' });
  const archived = await a.raw('PUT', `/api/v1/preparations/${a.preparationId}`, { expectedRevision: 1, state: 'archived' });
  assert.equal(archived.status, 200);
  const before = await w.store.inspect.fingerprint();
  await expectClientError(a.client.saveDraft(draft.id, { expectedRevision: 2, text: 'verweigert' }),
    'conflict', { status: 409, detail: 'preparation_archived' });
  await expectClientError(a.client.deleteAttempt(draft.id),
    'conflict', { status: 409, detail: 'preparation_archived' });
  assert.equal(await w.store.inspect.fingerprint(), before, 'archived refusals change no draft, history or balance');
  const read = await a.client.readAttempt(draft.id);
  assert.deepEqual([read.revision, read.text], [2, 'vor dem Archiv']);
  const resumed = await a.raw('PUT', `/api/v1/preparations/${a.preparationId}`, { expectedRevision: 2, state: 'active' });
  assert.equal(resumed.status, 200);
  assert.equal((await a.client.saveDraft(draft.id, { expectedRevision: 2, text: 'fortgesetzt' })).revision, 3);
  assert.deepEqual(await a.client.deleteAttempt(draft.id), { deleted: true });
});

/* -------------------------------------------------------------- ownership */

check('cross-owner-is-404-for-every-route', async () => {
  const w = await world();
  const a = await submitted(w, 'a');
  const openA = await a.client.createAttempt({ preparationId: a.preparationId });
  await a.client.saveDraft(openA.id, { expectedRevision: 1, text: 'A privat' });
  await w.store.worker.claim(a.receipt.submissionId);
  await w.store.worker.fail(a.receipt.submissionId, 'provider_unavailable'); // retry-eligible for A
  const b = await learner(w, 'b');
  const before = await w.store.inspect.fingerprint();

  const attempts = [
    ['read', () => b.client.readAttempt(openA.id), () => b.client.readAttempt(ATTEMPT_ABSENT)],
    ['save', () => b.client.saveDraft(openA.id, { expectedRevision: 2, text: 'B overwrite' }),
      () => b.client.saveDraft(ATTEMPT_ABSENT, { expectedRevision: 2, text: 'x' })],
    ['submit', () => b.client.submit(openA.id, { expectedRevision: 2, eventId: randomUUID() }),
      () => b.client.submit(ATTEMPT_ABSENT, { expectedRevision: 2, eventId: randomUUID() })],
    ['result', () => b.client.readResult(a.receipt.submissionId), () => b.client.readResult(SUBMISSION_ABSENT)],
    ['retry', () => b.client.retry(a.receipt.submissionId), () => b.client.retry(SUBMISSION_ABSENT)],
    ['delete', () => b.client.deleteAttempt(openA.id), () => b.client.deleteAttempt(ATTEMPT_ABSENT)],
    ['parent', () => b.client.createAttempt({ parentSubmissionId: a.receipt.submissionId }),
      () => b.client.createAttempt({ parentSubmissionId: SUBMISSION_ABSENT })],
    // EXAM-S1: A's preparation is not context B can create in, and looks exactly like an absent one.
    ['preparation', () => b.client.createAttempt({ preparationId: a.preparationId }),
      () => b.client.createAttempt({ preparationId: ATTEMPT_ABSENT })],
  ];
  for (const [label, foreign, absent] of attempts) {
    const e1 = await expectClientError(foreign(), 'not_found', { status: 404 });
    const e2 = await expectClientError(absent(), 'not_found', { status: 404 });
    assert.equal(e1.detail, e2.detail, `${label}: another owner's record must look exactly like an absent one`);
    assert.equal(e1.detail, 'not_found');
  }
  assert.equal(await w.store.inspect.fingerprint(), before, 'B changed nothing that belongs to A');
  // A still owns everything, unchanged.
  assert.equal((await a.client.readAttempt(openA.id)).text, 'A privat');
  assert.deepEqual(await a.client.retry(a.receipt.submissionId), { queued: true });
});

check('identity-is-never-accepted-from-input', async () => {
  const w = await world();
  const a = await learner(w, 'a');
  const b = await learner(w, 'b');
  const attemptA = await a.client.createAttempt({ preparationId: a.preparationId });
  // Identity smuggled in the body is refused, not honoured.
  for (const [method, url, body] of [
    ['POST', '/api/v1/attempts', { owner_id: a.account.id }],
    ['POST', '/api/v1/attempts', { ownerId: a.account.id }],
    ['PUT', `/api/v1/attempts/${attemptA.id}`, { expectedRevision: 1, text: 'x', owner_id: a.account.id }],
    ['POST', `/api/v1/attempts/${attemptA.id}/submissions`, { expectedRevision: 1, eventId: randomUUID(), userId: a.account.id }],
  ]) {
    const res = await b.raw(method, url, body);
    assert.equal(res.status, 422, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'unknown_field' });
  }
  // Identity in the query string is ignored: B still only sees B.
  const res = await b.raw('GET', `/api/v1/account?id=${encodeURIComponent(a.account.id)}`);
  assert.equal(res.json.id, b.account.id);
  const peek = await b.raw('GET', `/api/v1/attempts/${attemptA.id}?owner=${encodeURIComponent(a.account.id)}`);
  assert.equal(peek.status, 404);
});

/* ---------------------------------------------------------- error contract */

check('error-403-mutation-without-origin-gate', async () => {
  const w = await world();
  const a = await learner(w);
  const before = await w.store.inspect.fingerprint();
  for (const url of ['/api/v1/attempts', '/api/v1/no-such-route', '/api/auth/sign-in/email', '/api/auth/sign-out']) {
    const res = await a.raw('POST', url, {}, { originChecked: false });
    assert.equal(res.status, 403, url);
    assert.deepEqual(res.json, { error: 'origin_rejected' });
  }
  assert.equal(await w.store.inspect.fingerprint(), before);
  assert.equal(await w.sessions.liveSessions(a.account.id), 1, 'an ungated sign-out did not end the session');
  const read = await a.raw('GET', '/api/v1/account', undefined, { originChecked: false });
  assert.equal(read.status, 200, 'reads do not need the mutation gate');
});

check('error-404-unknown-routes-and-methods', async () => {
  const w = await world();
  const a = await learner(w);
  for (const [method, url] of [
    // `GET /api/v1/attempts` left this list: it is a supported history read. The collection's
    // unsupported methods stay here instead.
    ['GET', '/api/v1/nope'], ['GET', '/api/v1'], ['PUT', '/api/v1/attempts'], ['DELETE', '/api/v1/attempts'],
    ['PATCH', '/api/v1/attempts'],
    ['PATCH', `/api/v1/attempts/${ATTEMPT_ABSENT}`], ['GET', '/api/v1/attempts/not-a-uuid'],
    ['POST', `/api/v1/submissions/${SUBMISSION_ABSENT}`], ['GET', '/api/auth/unknown'], ['POST', '/api/auth/sign-in/social'],
  ]) {
    const res = await a.raw(method, url, method === 'GET' ? undefined : {});
    assert.equal(res.status, 404, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'not_found' });
  }
});

check('error-400-413-415-422', async () => {
  const w = await world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt({ preparationId: a.preparationId });
  const put = `/api/v1/attempts/${attempt.id}`;
  const cases = [
    [400, 'invalid_json', () => a.raw('PUT', put, '{"expectedRevision":1,')],
    [400, 'invalid_utf8', () => a.raw('PUT', put, new Uint8Array([0x7b, 0xff, 0x7d]))],
    [413, 'body_too_large', () => a.raw('PUT', put, JSON.stringify({ expectedRevision: 1, text: 'x'.repeat(70000) }))],
    [415, 'json_required', () => a.raw('PUT', put, '{}', { headers: { 'content-type': 'text/plain' } })],
    [422, 'invalid_body', () => a.raw('PUT', put, '[1,2]')],
    [422, 'invalid_draft', () => a.raw('PUT', put, { expectedRevision: 1, text: 'x'.repeat(12001) })],
    [422, 'invalid_draft', () => a.raw('PUT', put, { expectedRevision: 0, text: 'x' })],
    [422, 'invalid_submission', () => a.raw('POST', `${put}/submissions`, { expectedRevision: 1, eventId: 'not-a-uuid' })],
    [422, 'invalid_parent', () => a.raw('POST', '/api/v1/attempts', { parentSubmissionId: 42 })],
    [422, 'empty_submission', () => a.raw('POST', `${put}/submissions`, { expectedRevision: 1, eventId: randomUUID() })],
  ];
  const before = (await a.client.readAttempt(attempt.id)).revision;
  for (const [status, code, run] of cases) {
    const res = await run();
    assert.equal(res.status, status, code);
    assert.deepEqual(res.json, { error: code });
  }
  assert.equal((await a.client.readAttempt(attempt.id)).revision, before, 'no rejected request wrote a draft');
  // 12,000 UTF-16 code units exactly is accepted (text limit, not a byte limit).
  const ok = await a.raw('PUT', put, { expectedRevision: before, text: 'ä'.repeat(12000) });
  assert.equal(ok.status, 200);
});

check('error-500-is-redacted', async () => {
  const w = await world();
  const leaky = { ...w.store.port, async read() { throw new Error('SELECT * FROM attempts -- password=synthetic-secret'); } };
  const api = createOwnedApi({ datastore: leaky, sessions: w.sessions });
  const b = inProcessBrowser(api);
  await b.client.signUp({ name: 'R', email: nextEmail('r'), password: 'pw-synthetic' });
  const res = await b.raw('GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`);
  assert.equal(res.status, 500);
  assert.equal(res.text, '{"error":"internal_error"}');
  await expectClientError(b.client.readAttempt(ATTEMPT_ABSENT), 'server_error', { status: 500, detail: 'internal_error' });
});

/* ------------------------------------------------------------- fail closed */

check('fail-closed-without-ports', async () => {
  const w = await world();
  const a = await learner(w);
  const cookie = cookieHeader(a.jar);
  const partialStore = { ...w.store.port };
  delete partialStore.retry;
  const variants = [
    ['no ports', createOwnedApi()],
    ['no sessions', createOwnedApi({ datastore: w.store.port })],
    ['no datastore', createOwnedApi({ sessions: w.sessions })],
    ['partial datastore', createOwnedApi({ datastore: partialStore, sessions: w.sessions })],
    ['partial sessions', createOwnedApi({ datastore: w.store.port, sessions: { getSession: w.sessions.getSession } })],
  ];
  const callsBefore = w.store.inspect.calls.length;
  for (const [label, api] of variants) {
    assert.equal(api.configured, false, label);
    for (const [method, url] of [['GET', '/api/v1/account'], ['GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`],
      ['POST', '/api/v1/attempts'], ['POST', '/api/auth/sign-in/email']]) {
      const res = await api.handle({ method, path: url, headers: { cookie, 'content-type': 'application/json' }, body: '{}', originChecked: true });
      assert.equal(res.status, 503, `${label}: ${method} ${url}`);
      assert.equal(res.body, '{"error":"not_configured"}');
    }
    const client = createOwnedClient({ fetchImpl: inProcessBrowser(api).fetchImpl });
    await expectClientError(client.refreshAccount(), 'server_error', { status: 503 });
  }
  assert.equal(w.store.inspect.calls.length, callsBefore, 'no datastore method ran');

  /*
   * THE SESSION LIFECYCLE IS AN OPTIONAL CAPABILITY TOO — and it must be tested with a port that genuinely
   * lacks it, not with whichever backend happens to be running.
   *
   * The FIRST version of this block used the world's own API and asserted 503 on the three routes. It passed
   * on memory and FAILED on postgres, because the real port implements the lifecycle there and the routes
   * correctly work: the leg was asserting a property of the memory fake while claiming to assert a property
   * of the seam. So the reduced port is built EXPLICITLY, the same way `partialStore` above removes `retry` —
   * identical on both backends, and about the capability rather than about the backend.
   *
   * Why assert a REFUSAL instead of teaching the memory fake the lifecycle: the product implementation is the
   * PostgreSQL port, the four behaviours have their own six legs against a real database
   * (`session-lifecycle-check.mjs`), and a second hand-written implementation inside a test fake would be a
   * second source of truth for `session` semantics — free to disagree with the one that ships, with no check
   * able to tell. What must be proven HERE is the fail-closed property: an implementation that cannot do this
   * loses the routes, never the product, and never throws a TypeError into a 500.
   */
  {
    const partialSessions = { ...w.sessions };
    for (const method of ['listSessions', 'revokeSession', 'changePassword', 'sweepExpired']) delete partialSessions[method];
    assert.ok(typeof partialSessions.getSession === 'function', 'the reduced port still authenticates, so only the lifecycle is missing');
    const reduced = createOwnedApi({ datastore: w.store.port, settings: w.settings, sessions: partialSessions });
    assert.equal(reduced.configured, true, 'the reduced server is CONFIGURED: these routes are optional, not the product');

    const a2 = await learner(w, 'lifecycle');
    const cookie2 = cookieHeader(a2.jar);
    for (const [method, url] of [['GET', '/api/v1/sessions'], ['DELETE', `/api/v1/sessions/${randomUUID()}`],
      ['PUT', '/api/v1/account/password']]) {
      const res = await reduced.handle({
        method, path: url, headers: { cookie: cookie2, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}', originChecked: true,
      });
      assert.equal(res.status, 503, `${method} ${url} must be 503 without the lifecycle capability, got ${res.status}`);
      assert.equal(JSON.parse(res.body).error, 'session_lifecycle_unavailable', `${method} ${url}: the reason is named`);
    }
    // AND THE PRODUCT IS NOT LOST: everything else on the reduced server still works for a real session.
    const account = await reduced.handle({ method: 'GET', path: '/api/v1/account', headers: { cookie: cookie2 }, originChecked: true });
    assert.equal(account.status, 200, 'only the lifecycle routes are missing, not the account route');
  }
});

check('garbage-session-port-output-is-401', async () => {
  const w = await world();
  for (const value of [{ userId: '' }, { userId: '   ' }, { userId: 42 }, 'user-a', ['user-a'], undefined]) {
    const api = createOwnedApi({ datastore: w.store.port, sessions: { ...w.sessions, getSession: async () => value } });
    const res = await api.handle({ method: 'GET', path: '/api/v1/account' });
    assert.equal(res.status, 401, JSON.stringify(value));
  }
});

/* =================================== content records (SAAS-MODEL-01 Step 1) */

/*
 * TWO ARTIFACTS, ONE CONTENT — retargeted in SPA-RETIRE 2.
 *
 * This leg used to compare the fixture against `public/js/ai.js`, the CLIENT module that originally
 * held the six prompts. That module goes with the SPA, so the surviving pair is the one that actually
 * ships: **migration 0006**, which seeds the database, and **`content-seed.mjs`**, which the tests
 * provision with. Comparing them is not self-comparison — they are different files, written at
 * different times, and the failure it catches is real: the database serving one text while the test
 * path exercises another, so every green leg describes content nobody will see.
 *
 * SQL escaping is normalised rather than guessed: an apostrophe is doubled inside a SQL literal, so
 * both sides have their quote characters removed before the containment test.
 */
check('content-seed-and-the-seeded-migration-agree', async () => {
  const {
    WRITING_TASKS, FORMATIVE_WRITING_RUBRIC, TELC_B1_WRITING_RUBRIC, TELC_B1_TASK_VERSION, taskBindings,
  } = await import('../server/owned-postgres/content-seed.mjs');
  assert.equal(WRITING_TASKS.length, 6, 'the writing family is 6 prompts (3 du + 3 Sie)');

  /*
   * TWO RUBRICS, SEPARATELY VERSIONED, NEVER RENORMALISED INTO EACH OTHER.
   *
   * This leg used to assert `WRITING_RUBRIC.criteria.length === 4` — "four internal criteria, never
   * relabelled as telc three" — which was the right guard while the four-criterion formative rubric was the
   * only one. Ron's D4/R11 answer (2 October 2026) changed the contract: the feedback follows the exam's own
   * marking structure, so there are now TWO and the property is not "four, not three" but **"two distinct
   * contracts that must never be mixed"**. The retired one keeps its rows (the catalogue is immutable and old
   * attempts are bound to it); the current one is what new task versions declare.
   */
  assert.equal(FORMATIVE_WRITING_RUBRIC.criteria.length, 4, 'the RETIRED rubric keeps its four criteria');
  assert.equal(FORMATIVE_WRITING_RUBRIC.rubricId, 'writing.formative');
  assert.equal(TELC_B1_WRITING_RUBRIC.criteria.length, 3, "the CURRENT rubric is telc B1's three criteria");
  assert.equal(TELC_B1_WRITING_RUBRIC.maxTotal, 45);
  for (const criterion of TELC_B1_WRITING_RUBRIC.criteria) {
    assert.deepEqual(Object.keys(criterion.bands), ['A', 'B', 'C', 'D'], `${criterion.key} carries the A-D band scale`);
    assert.equal(criterion.max, criterion.bands.A * criterion.factor, `${criterion.key}.max is band A x factor`);
  }
  assert.notEqual(TELC_B1_WRITING_RUBRIC.rubricId, FORMATIVE_WRITING_RUBRIC.rubricId);
  const formativeKeys = FORMATIVE_WRITING_RUBRIC.criteria.map((c) => c.key).sort().join(',');
  const telcKeys = TELC_B1_WRITING_RUBRIC.criteria.map((c) => c.key).sort().join(',');
  assert.notEqual(formativeKeys, telcKeys, `the two rubrics must not share a criteria set (both were ${telcKeys})`);

  const bare = (value) => String(value).replace(/'/g, '');
  const six = fs.readFileSync(new URL('../server/migrations/0006-content-and-catalogue.sql', import.meta.url), 'utf8');
  const seventeen = fs.readFileSync(new URL('../server/migrations/0017-telc-b1-rubric.sql', import.meta.url), 'utf8');
  const haystack = bare(six);
  const missing = [];
  for (const task of WRITING_TASKS) {
    const fields = [['topic', task.topic], ['situation', task.situation], ['adressat', task.adressat],
      ...task.leitpunkte.map((line, index) => [`leitpunkt${index + 1}`, line])];
    for (const [field, value] of fields) {
      if (!haystack.includes(bare(value))) missing.push(`${task.taskId}.${field}`);
    }
  }
  for (const criterion of FORMATIVE_WRITING_RUBRIC.criteria) {
    if (!haystack.includes(bare(criterion.label))) missing.push(`formative.${criterion.key}`);
  }
  assert.deepEqual(missing, [], 'these fields are in the fixture but not in the migration that seeds the database');

  // AND 0017 MUST AGREE WITH THE SEED IT CAME FROM — the guard that catches a hand-edited migration.
  const missingNew = [];
  for (const criterion of TELC_B1_WRITING_RUBRIC.criteria) {
    if (!seventeen.includes(`"key":"${criterion.key}"`)) missingNew.push(`telc.${criterion.key}`);
    if (!seventeen.includes(`"bands":{"A":${criterion.bands.A},"B":${criterion.bands.B},"C":${criterion.bands.C},"D":${criterion.bands.D}}`)) {
      missingNew.push(`telc.${criterion.key}.bands`);
    }
  }
  for (const binding of taskBindings()) {
    if (binding.version === TELC_B1_TASK_VERSION && !seventeen.includes(`'${binding.taskId}', '${binding.version}'`)) {
      missingNew.push(`binding ${binding.taskId}@${binding.version}`);
    }
  }
  if (seventeen.includes('"key":"ausdruck"')) missingNew.push('the retired criterion leaked into 0017');
  assert.deepEqual(missingNew, [], 'migration 0017 and the seed disagree');

  // The default binding must be a DECLARED pair — the tuple rule, not two independent checks.
  const declared = taskBindings().find((row) => row.taskId === DEFAULT_TASK_BINDING.taskId
    && row.version === DEFAULT_TASK_BINDING.taskVersion
    && row.rubricId === DEFAULT_TASK_BINDING.rubricId
    && row.rubricVersion === DEFAULT_TASK_BINDING.rubricVersion);
  assert.ok(declared, 'the default binding must be a pair the catalogue declares');
  assert.equal(DEFAULT_TASK_BINDING.taskVersion, TELC_B1_TASK_VERSION, 'new attempts bind the version with the current rubric');
  assert.equal(DEFAULT_TASK_BINDING.rubricId, TELC_B1_WRITING_RUBRIC.rubricId);
  return `migration 0006: 6 prompts + the retired 4-criteria rubric; migration 0017: task ${TELC_B1_TASK_VERSION} + telc B1's 3 criteria (A-D bands); the two never share a criteria set`;
});

/*
 * An attempt must bind an EXACT task and rubric version, and reading it back must return the
 * same versions — not the two synthetic constants every attempt carried before this slice.
 * The submission snapshot copies the attempt's versions, so the claim survives the grade.
 */
check('attempt-binds-an-exact-task-and-rubric-version', async () => {
  const w = await world();
  const who = await learner(w, 'bind');
  const attempt = await who.client.createAttempt({ preparationId: who.preparationId });
  const read = await who.client.readAttempt(attempt.id);
  assert.equal(read.task_version, DEFAULT_TASK_BINDING.taskVersion, 'the attempt binds the default task version');
  assert.equal(read.rubric_version, DEFAULT_TASK_BINDING.rubricVersion, 'and the real rubric version');
  assert.equal(read.task_id, DEFAULT_TASK_BINDING.taskId);
  assert.notEqual(read.task_version, 'synthetic-writing-v1', 'the synthetic constant must be gone from new attempts');

  // An explicit binding for a different real task is honoured and reads back unchanged.
  const other = WRITING_TASKS.find((t) => t.taskId.endsWith('sprachkurs'));
  // The CURRENT binding: task v2 with the telc B1 rubric. The retired pair is still servable for an OLD
  // attempt, but a new attempt binds what the catalogue declares today.
  const bound = await w.store.port.create(who.account.id, null, {
    taskId: other.taskId, taskVersion: TELC_B1_TASK_VERSION,
    rubricId: TELC_B1_WRITING_RUBRIC.rubricId, rubricVersion: TELC_B1_WRITING_RUBRIC.version,
  }, who.preparationId);
  const readBound = await w.store.port.read(who.account.id, bound.id);
  assert.equal(readBound.task_id, other.taskId);
  assert.equal(readBound.task_version, TELC_B1_TASK_VERSION);

  const draft = await who.client.saveDraft(attempt.id, { expectedRevision: attempt.revision, text: 'Sehr geehrte Damen und Herren, ich schreibe wegen des Kurses.' });
  const receipt = await who.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
  const result = await who.client.readResult(receipt.submissionId);
  assert.equal(result.submission.task_version, DEFAULT_TASK_BINDING.taskVersion, 'the submission snapshots the bound version');
  assert.equal(result.submission.rubric_version, DEFAULT_TASK_BINDING.rubricVersion);
  return `bound ${DEFAULT_TASK_BINDING.taskId}@${DEFAULT_TASK_BINDING.taskVersion} / ${DEFAULT_TASK_BINDING.rubricId}@${DEFAULT_TASK_BINDING.rubricVersion} and read it back`;
});

/* ============================================ server.js mount (HTTP layer) */

/*
 * SAAS-MODEL-01 Step 2, at the real entry point: `node server.js` with no account/database
 * configuration. The OLD behaviour was a working single-user app beside 404 owned routes. The
 * new contract is a refusal: readiness is false, learner routes answer 503, and the single-user
 * path is not served. Bounded - the child is always reaped, every request has a timeout.
 */
check('entry-point-fails-closed-without-accounts-config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-api-failclosed-'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const env = { ...process.env, B1PREP_PORT: String(port), B1PREP_FORCE_OFFLINE: '1',
    B1PREP_ENV_FILE: path.join(dir, 'e.env'), B1PREP_PROGRESS_FILE: path.join(dir, 'p.json') };
  for (const key of Object.keys(env)) if (key === 'B1PREP_ACCOUNTS' || key === 'B1PREP_SAAS' || key.startsWith('OWNAPI_PG_')) delete env[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(fileURLToPath(import.meta.url), '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${log.slice(-300)}`);
      try { if ((await get('/api/health')).status === 200) break; } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`server did not answer: ${log.slice(-300)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const ready = await get('/api/ready');
    assert.equal(ready.status, 503, 'readiness must fail closed');
    assert.equal(ready.json?.ready, false);
    assert.ok(/B1PREP_ACCOUNTS/.test(String(ready.json?.reason || '')), `reason must name the missing configuration, got ${ready.json?.reason}`);
    for (const p of ['/api/v1/account', '/api/progress']) {
      assert.equal((await get(p)).status, 503, `${p} must be refused while unconfigured`);
    }
    assert.ok(!/runs single-user/.test(log), `the entry point must not report a single-user fallback:\n${log}`);
    assert.ok(!fs.existsSync(path.join(dir, 'p.json')), 'no unscoped progress file may be created');
  } finally {
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); }
    await new Promise((r) => child.once('exit', r) || setTimeout(r, 500));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// server.js resolves its .env and progress paths once, at first import, so the
// throwaway directory is created once per run and removed after the last check.
let legacy = null;
async function legacyModule() {
  if (!legacy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-api-check-'));
    process.env.B1PREP_FORCE_OFFLINE = '1';
    process.env.B1PREP_ENV_FILE = path.join(dir, 'throwaway.env');
    process.env.B1PREP_PROGRESS_FILE = path.join(dir, 'progress.json');
    legacy = { dir, progressPath: process.env.B1PREP_PROGRESS_FILE, module: await import('../server.js') };
  }
  return legacy;
}

async function startLegacyServer(options) {
  const { module, progressPath } = await legacyModule();
  const server = options === undefined ? module.createServer() : module.createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, progressPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function serverSupportsMount() {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // Was `/OWNAPI-01 mount/` - a comment string. It is a MARKER, not a proof: renaming the
  // comment made two checks fail as "no mount point" while the mount was working perfectly,
  // and a comment could equally stay while the mount was removed. Look for the call that
  // actually resolves the API and hands it to the mount, and keep a marker for readability.
  return /resolveOwnedApi\(req\.socket\.server\)/.test(source) && /\.handleNode\(req, res/.test(source);
}

check('server-mount-off-by-default', async () => {
  const ctx = await startLegacyServer();
  try {
    const b = httpBrowser(ctx.port);
    const res = await b.request({ method: 'GET', url: '/api/v1/account' });
    assert.equal(res.status, 404, 'without an injected owned API, /api/v1 does not exist');
    const health = await b.request({ method: 'GET', url: '/api/health' });
    assert.equal(health.status, 200, 'legacy routes unchanged');
  } finally { await ctx.close(); }
});

check('server-mount-behind-sec01-origin-gate', async () => {
  if (!(await serverSupportsMount())) throw new Error('server.js has no OWNAPI-01 mount point');
  const w = await world();
  const ctx = await startLegacyServer({ ownedApi: w.api });
  try {
    const foreign = httpBrowser(ctx.port, { origin: 'http://attacker.example' });
    const before = await w.store.inspect.fingerprint();
    for (const url of ['/api/auth/sign-up/email', '/api/v1/attempts', '/api/v1/no-such-route']) {
      const res = await foreign.request({ method: 'POST', url, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', email: 'x@example.invalid', password: 'pw' }) });
      assert.equal(res.status, 403, `foreign-origin POST ${url}`);
    }
    const absent = httpBrowser(ctx.port, { origin: null });
    const noOrigin = await absent.request({ method: 'POST', url: '/api/v1/attempts', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403, 'absent Origin and Referer is rejected');
    assert.equal(await w.store.inspect.fingerprint(), before, 'no rejected request reached the datastore');
    assert.equal(await w.sessions.liveSessions(null), 0, 'no cross-origin sign-up created a session');
  } finally { await ctx.close(); }
});

check('server-mount-real-client-over-http', async () => {
  if (!(await serverSupportsMount())) throw new Error('server.js has no OWNAPI-01 mount point');
  const w = await world();
  const ctx = await startLegacyServer({ ownedApi: w.api });
  try {
    const a = httpBrowser(ctx.port);
    const account = await a.client.signUp({ name: 'H', email: nextEmail('h'), password: 'pw-http-synthetic' });
    const listed = await a.request({ method: 'GET', url: '/api/v1/preparations', headers: { accept: 'application/json' } });
    assert.equal(listed.status, 200, `the preparation list must answer over HTTP, got ${listed.status}`);
    const attempt = await a.client.createAttempt({ preparationId: activeInitialPreparation(JSON.parse(listed.text)) });
    const draft = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'über HTTP' });
    const receipt = await a.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
    const result = await a.client.readResult(receipt.submissionId);
    assert.equal(result.submission.text, 'über HTTP');
    await expectClientError(a.client.deleteAttempt(attempt.id), 'conflict', { status: 409, detail: 'submitted_attempt' });
    assert.equal((await a.client.readResult(receipt.submissionId)).submission.text, 'über HTTP', 'submitted work survives a delete');
    const b = httpBrowser(ctx.port);
    await b.client.signUp({ name: 'H2', email: nextEmail('h'), password: 'pw-http-synthetic' });
    await expectClientError(b.client.readResult(receipt.submissionId), 'not_found', { status: 404 });
    const raw = await a.request({ method: 'GET', url: '/api/v1/account' });
    assert.equal(raw.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(raw.text).id, account.id);
    assert.equal(fs.existsSync(ctx.progressPath), false, 'the legacy JSON progress store was never written');
  } finally { await ctx.close(); }
});

/* ==================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

/**
 * Run every check against one backend.
 * @param {{backend?: 'memory'|'postgres'}} [options]
 *   'memory' is the original in-memory double. 'postgres' requires the
 *   server/owned-postgres package installed and a disposable database (see its
 *   README); it is the only mode that exercises FORCE ROW LEVEL SECURITY.
 */
export async function runOwnedApiChecks({ backend = 'memory' } = {}) {
  if (!['memory', 'postgres', 'postgres-persistent'].includes(backend)) throw new Error(`unknown backend: ${backend}`);
  BACKEND = backend;
  const results = [];
  /*
   * EXAM-S0: the default content mode is `public` (approved only), and every fixture row here is
   * `unreviewed`. This suite therefore opts into `internal-preview` EXPLICITLY, for its own run only, and
   * restores the previous value afterwards — an importer of this module does not inherit it.
   */
  const previousMode = process.env.B1PREP_CONTENT_MODE;
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  try {
    for (const { name, run } of checks) {
      try {
        await run();
        results.push({ name, ok: true, detail: 'ok' });
      } catch (error) {
        results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
      } finally {
        // Close each PostgreSQL world immediately: bounds open schemas, roles and
        // pooled connections to one at a time.
        await closeWorlds();
      }
    }
  } finally {
    await closeWorlds();
    if (previousMode === undefined) delete process.env.B1PREP_CONTENT_MODE;
    else process.env.B1PREP_CONTENT_MODE = previousMode;
  }
  if (legacy) fs.rmSync(legacy.dir, { recursive: true, force: true });
  return { ok: results.every((r) => r.ok), backend, results };
}

/**
 * The sentence a reader takes away from a run. It must describe the backend that actually ran.
 *
 * DEFECT FIXED 2026-10-01 (coordinator, from the combined-head re-execution): this was
 * `report.backend === 'postgres' ? <postgres note> : <memory note>`. `postgres-persistent` is a
 * THIRD backend (`:922` admits it), and it is the one the CI `postgres` job runs
 * (`.github/workflows/ci.yml:141`) — so the run that proves the durable property on real
 * PostgreSQL printed `in-memory datastore and session fakes only; no PostgreSQL/RLS evidence`.
 * The checks were all correct; the sentence told the reader the opposite of what happened.
 *
 * Unknown backends are named rather than defaulted, so a fourth backend added later cannot
 * inherit a true-sounding sentence it did not earn.
 */
export function backendNote(backend) {
  if (backend === 'postgres' || backend === 'postgres-persistent') {
    return 'NOTE real PostgreSQL datastore as the restricted learner role with FORCE RLS; synthetic sessions.';
  }
  if (backend === 'memory') {
    return 'NOTE in-memory datastore and session fakes only; no PostgreSQL/RLS evidence. Add --backend=postgres for that.';
  }
  return `NOTE unrecognised backend "${backend}": this run makes NO claim about PostgreSQL or RLS.`;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const backendArg = process.argv.find((a) => a.startsWith('--backend='));
  const backend = backendArg ? backendArg.slice('--backend='.length) : 'memory';
  const report = await runOwnedApiChecks({ backend });
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 4).join('\n'));
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed (backend: ${report.backend})`);
  console.log(backendNote(report.backend));
  process.exitCode = failed ? 1 : 0;
}

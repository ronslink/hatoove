/**
 * PRACTICE-MEDIA (task-17) — the practice-bound listening playback port.
 *
 * THE SAME MODEL, BOUND TO A SITTING. `server/owned-postgres/playback.mjs` is the mock path: a form-bound run,
 * per-(run, recording) `plays_used`/`max_plays` in `listening_playback`, one-way state machine, acknowledged
 * `begin` + event-id idempotency, integrity-first (a missing or corrupt file never debits a play). All of that
 * behaviour is REUSED here — `playbackDto`, `playbackTransition`, `recoveryPosition`, `readMediaBytes` and the
 * HTTP framing in `media-route.mjs`. What is new is only the binding: the accounting key is a `practice_attempt`
 * (one released set of one part, untimed, no form), stored in `practice_playback` (migration 0045).
 *
 * THE PRACTICE RULE. The allowance is the EXAM allowance for the part's family — the blueprint's
 * `playback->>'mock'` (telc B1: HV1 1, HV2 2, HV3 2), the same number slice B serves to the learner. On top of
 * it, every play after the FIRST requires the sitting to be `checked`: a second listen before "Auswerten" is
 * refused by this transition AND independently by the SQL trigger, so no caller can skip it.
 *
 * BYTES NEED A PLAY IN PROGRESS. Unlike the mock media route, which serves bytes to the owner of an active run,
 * this route refuses the audio bytes unless an acknowledged play is currently `playing` or `paused`. Without
 * that, "a second listen before Auswerten is refused" would be true only of the state machine while the file
 * itself stayed re-fetchable — the acceptance criterion is about the LISTEN. HEAD is subject to the same rule,
 * because the client never needs the file's metadata before `begin` (the playback DTO carries `duration_ms`).
 */
import { createHash } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { validatePlaybackEvent } from '../media-route.mjs';
import { readMediaBytes } from '../media-contract.mjs';
import { requireActivePreparation } from './preparations.mjs';
import { lockMockOwner } from './mock-runs.mjs';
import { playbackDto, playbackTransition } from './playback.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];

/** Codes the practice SQL raises that must reach the learner as a decision, not as a 500. */
const KNOWN_SQL = ['playback_conflict', 'playback_exhausted', 'playback_recovery_required', 'playback_required',
  'practice_check_required', 'practice_rights_blocked', 'preparation_archived'];

function sqlFault(error) {
  if (error instanceof Fault) throw error;
  if (KNOWN_SQL.includes(error?.message)) fail(409, error.message);
  if (error?.message === 'not_found') fail(404, 'not_found');
  throw error;
}

/**
 * The practice rule, applied on top of the SHARED transition so the two paths cannot drift.
 *
 * ORDER MATTERS, and REVIEW-PRACTICE-MEDIA F1 is why. The shared transition runs **first**, so its precise
 * structural codes surface — a stale `expectedRevision` is `playback_conflict`, a spent allowance is
 * `playback_exhausted`, a play still running is `playback_recovery_required`. Only a STRUCTURALLY VALID
 * `begin` is then subject to the practice rule (`used > 0` means this recording already had its first play, so
 * from then on the sitting must be `checked`). Running the rule first — which this function used to do —
 * masked all three codes behind `practice_check_required` and told a client to re-check when it should have
 * resynced its revision.
 *
 * This is the SAME precedence the SQL trigger enforces (`0045`: identity, revision and count checks first,
 * `practice_check_required` last), so the two layers now agree instead of disagreeing.
 */
export function practicePlaybackTransition(row, recording, body, now, { attempt } = {}) {
  const used = row ? Number(row.plays_used) : 0;
  const next = playbackTransition(row, recording, body, now);
  if (body.action === 'begin' && used > 0 && attempt?.state !== 'checked') fail(409, 'practice_check_required');
  return next;
}

export function practicePlaybackMethods({ settle, catalogue, note = () => {}, mediaRoot }) {
  const transaction = (owner, work) => settle(owner, work).catch(sqlFault);

  async function context(client, owner, attemptId) {
    // Same lock order as checkPracticeAttempt and account deletion: owner, then exam, then the sitting.
    await lockMockOwner(client, owner);
    const attempt = first(await client.query(
      'SELECT *, clock_timestamp() AS server_now FROM practice_attempt WHERE attempt_id=$1 AND owner_id=$2 FOR UPDATE',
      [attemptId, owner]));
    if (!attempt) fail(404, 'not_found');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))', [attempt.exam_id]);
    const prep = await requireActivePreparation(client, owner, attempt.preparation_id);
    if (!catalogue.isEnabled(prep.exam_id)) fail(422, 'exam_unavailable');
    return { attempt, recordings: await recordingsOf(client, attempt) };
  }

  /**
   * The recordings the SERVED SET actually carries, with the imported file's duration and the blueprint's
   * EXAM allowance. A set with no authored `recordings` yields an EMPTY list rather than an error: the seeded
   * telc HV sets in migration 0010 carry `items` and no audio at all, and the runner must show its honest
   * "no audio for this set" state instead of a broken player. Authored recordings whose media row was never
   * imported are a LOUD failure — silently dropping audio would misreport what the set contains.
   */
  async function recordingsOf(client, attempt) {
    const set = first(await client.query(
      'SELECT payload, family, section FROM objective_set WHERE set_id=$1 AND version=$2 AND exam_id=$3',
      [attempt.set_id, attempt.version, attempt.exam_id]));
    const authored = Array.isArray(set?.payload?.recordings) ? set.payload.recordings : [];
    if (!authored.length) return [];
    const allowance = first(await client.query(
      `SELECT (part.value->'playback'->>'mock')::integer AS max_plays
         FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version
         JOIN exam_blueprint b ON b.exam_id=r.exam_id AND b.version=r.blueprint_version
         CROSS JOIN LATERAL jsonb_array_elements(b.payload->'sections') section
         CROSS JOIN LATERAL jsonb_array_elements(section.value->'parts') part
        WHERE h.exam_id=$1 AND part.value->>'family'=$2 AND part.value->>'mediaRequired'='true'`,
      [attempt.exam_id, set.family]));
    /*
     * REVIEW-PRACTICE-MEDIA F3: this guard could not fire. `(part->'playback'->>'mock')::integer` is NULL for
     * a part with NO playback rule, and `Number(null)` is 0 while `Number.isInteger(0)` is true — so the NULL
     * passed straight through, `recordingsOf` reported `max_plays: 0`, and the trigger answered
     * `invalid_playback_identity` instead of the intended code. Unreachable while no shipped set carries
     * recordings, which is exactly the partial-import state the listening work creates, so NULL and absent are
     * now detected explicitly and a non-positive allowance is refused the same way.
     */
    const maxPlays = allowance === undefined || allowance === null ? null : allowance.max_plays;
    if (maxPlays === null || maxPlays === undefined || !Number.isInteger(Number(maxPlays)) || Number(maxPlays) < 1) {
      fail(409, 'practice_playback_unavailable');
    }
    const media = (await client.query(
      `SELECT media_id, version, duration_ms, mime_type, sha256, byte_length, path FROM exam_media
        WHERE exam_id=$1 AND media_id = ANY($2::text[]) AND version = ANY($3::text[])`,
      [attempt.exam_id, authored.map((r) => String(r.mediaId)), authored.map((r) => String(r.mediaVersion))])).rows;
    return authored.map((authoredRecording) => {
      const found = media.find((row) => row.media_id === String(authoredRecording.mediaId)
        && row.version === String(authoredRecording.mediaVersion));
      if (!found) fail(409, 'media_unavailable');
      return {
        media_id: found.media_id, media_version: found.version,
        label: typeof authoredRecording.label === 'string' ? authoredRecording.label : '',
        duration_ms: Number(found.duration_ms), max_plays: Number(maxPlays),
        mime_type: found.mime_type, sha256: found.sha256, byte_length: Number(found.byte_length), path: found.path,
      };
    });
  }

  /** The same integrity-first rule as the mock path: a missing or corrupt resource never debits a play. */
  async function bytesOf(recording) {
    try { return await readMediaBytes(recording, { mediaRoot }); }
    catch (error) {
      fail(409, error?.code === 'media_integrity' || error?.message === 'media_integrity' ? 'media_integrity' : 'media_unavailable');
    }
  }

  return {
    /** The playback state of every recording of this sitting, plus the sitting's own counters. */
    async readPracticePlayback(owner, attemptId) {
      note('readPracticePlayback');
      return transaction(owner, async (client) => {
        const { attempt, recordings } = await context(client, owner, attemptId);
        const rows = (await client.query(
          'SELECT * FROM practice_playback WHERE owner_id=$1 AND attempt_id=$2', [owner, attemptId])).rows;
        return {
          items: recordings.map((recording) => playbackDto(
            rows.find((row) => row.media_id === recording.media_id && row.media_version === recording.media_version),
            recording, attempt.server_now)),
          sitting: { attempt_id: attempt.attempt_id, state: attempt.state, checked: attempt.state === 'checked',
            plays_used: Number(attempt.plays_used), replay_used: attempt.replay_used === true },
        };
      });
    },
    async mutatePracticePlayback(owner, attemptId, input) {
      note('mutatePracticePlayback');
      const body = validatePlaybackEvent(input);
      const sha = createHash('sha256').update(JSON.stringify({ attemptId, body })).digest('hex');
      return transaction(owner, async (client) => {
        await lockMockOwner(client, owner);
        const prior = first(await client.query(
          'SELECT * FROM practice_playback_event WHERE owner_id=$1 AND event_id=$2', [owner, body.eventId]));
        if (prior && (prior.attempt_id !== attemptId || prior.request_sha256 !== sha)) fail(409, 'playback_conflict');
        if (prior) {
          const saved = first(await client.query(
            `SELECT *, clock_timestamp() AS server_now FROM practice_playback
              WHERE owner_id=$1 AND attempt_id=$2 AND media_id=$3 AND media_version=$4`,
            [owner, attemptId, body.mediaId, body.mediaVersion]));
          if (!saved) fail(404, 'not_found');
          return playbackDto(saved, saved, saved.server_now);
        }
        const { attempt, recordings } = await context(client, owner, attemptId);
        const recording = recordings.find((row) => row.media_id === body.mediaId && row.media_version === body.mediaVersion);
        if (!recording) fail(404, 'not_found');
        let row = first(await client.query(
          `SELECT * FROM practice_playback
            WHERE owner_id=$1 AND attempt_id=$2 AND media_id=$3 AND media_version=$4 FOR UPDATE`,
          [owner, attemptId, body.mediaId, body.mediaVersion]));
        if (body.action === 'begin') await bytesOf(recording); // A missing/corrupt resource never debits.
        const now = first(await client.query('SELECT clock_timestamp() AS now')).now;
        const next = practicePlaybackTransition(row, recording, body, now, { attempt });
        if (!row) {
          row = first(await client.query(`INSERT INTO practice_playback
            (owner_id,attempt_id,exam_id,media_id,media_version,max_plays,duration_ms,state,plays_used,position_ms,playback_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [owner, attemptId, attempt.exam_id, body.mediaId, body.mediaVersion, recording.max_plays,
            recording.duration_ms, next.state, next.plays_used, next.position_ms, next.playback_id]));
        } else {
          row = first(await client.query(`UPDATE practice_playback SET state=$5,plays_used=$6,position_ms=$7,playback_id=$8,
            revision=revision+1,updated_at=clock_timestamp()
            WHERE owner_id=$1 AND attempt_id=$2 AND media_id=$3 AND media_version=$4 RETURNING *`,
          [owner, attemptId, body.mediaId, body.mediaVersion, next.state, next.plays_used, next.position_ms, next.playback_id]));
        }
        await client.query(`INSERT INTO practice_playback_event(owner_id,event_id,attempt_id,media_id,media_version,request_sha256,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [owner, body.eventId, attemptId, body.mediaId, body.mediaVersion, sha, row.revision]);
        return playbackDto(row, recording, row.updated_at, false);
      });
    },
    /** Bytes of the served recording — only while an acknowledged play of it is actually in progress. */
    async readPracticeMedia(owner, attemptId, mediaId, version) {
      note('readPracticeMedia');
      return transaction(owner, async (client) => {
        const { recordings } = await context(client, owner, attemptId);
        const recording = recordings.find((row) => row.media_id === mediaId && row.media_version === version);
        if (!recording) fail(404, 'not_found');
        const row = first(await client.query(
          `SELECT state FROM practice_playback
            WHERE owner_id=$1 AND attempt_id=$2 AND media_id=$3 AND media_version=$4`,
          [owner, attemptId, mediaId, version]));
        if (!row || !['playing', 'paused'].includes(row.state)) fail(409, 'playback_required');
        const bytes = await bytesOf(recording);
        // Filesystem I/O may take time: recheck the sitting before returning bytes.
        await context(client, owner, attemptId);
        return { bytes, media: { mime_type: recording.mime_type, sha256: recording.sha256 } };
      });
    },
  };
}

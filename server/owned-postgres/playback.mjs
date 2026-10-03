/** Saved fixed listening. Ownership is the session owner in the adapter transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { validatePlaybackEvent } from '../media-route.mjs';
import { readMediaBytes } from '../media-contract.mjs';
import { requireActivePreparation } from './preparations.mjs';
import { readReleasedForm } from './packages.mjs';
import { lockMockOwner, requireMockGroup } from './mock-runs.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = result => result.rows[0];
const iso = value => value instanceof Date ? value.toISOString() : value;

/** The conservative return position is only advanced while playback was acknowledged as playing. */
export function recoveryPosition(row, now) {
  const elapsed = row.state === 'playing' ? Math.max(0, new Date(now).getTime() - new Date(row.updated_at).getTime()) : 0;
  return Math.min(Number(row.duration_ms), Number(row.position_ms) + Math.floor(elapsed));
}

export function playbackDto(row, recording, now, returned = true) {
  return {
    media_id: recording.media_id, media_version: recording.media_version,
    revision: row ? Number(row.revision) : 0, state: row?.state ?? 'ready',
    plays_used: row ? Number(row.plays_used) : 0, max_plays: Number(recording.max_plays),
    position_ms: row ? (returned ? recoveryPosition(row, now) : Number(row.position_ms)) : 0,
    duration_ms: Number(recording.duration_ms), playback_id: row?.playback_id ?? null,
    uncertain: Boolean(returned && row?.state === 'playing'), server_now: iso(now),
  };
}

/** Pure transition used by the transaction; the SQL trigger independently protects stored state. */
export function playbackTransition(row, recording, body, now) {
  if ((row ? Number(row.revision) : 0) !== body.expectedRevision) fail(409, 'playback_conflict');
  if (body.action === 'begin') {
    if (row && row.state !== 'completed') fail(409, 'playback_recovery_required');
    const used = row ? Number(row.plays_used) : 0;
    if (used >= Number(recording.max_plays)) fail(409, 'playback_exhausted');
    return { state: 'playing', plays_used: used + 1, position_ms: 0, playback_id: randomUUID() };
  }
  if (!row || body.playbackId !== row.playback_id) fail(409, 'playback_conflict');
  if (row.state === 'completed') fail(409, 'playback_exhausted');
  if (body.action === 'recover') {
    const position = recoveryPosition(row, now);
    return { state: position === Number(recording.duration_ms) ? 'completed' : 'playing',
      plays_used: Number(row.plays_used), position_ms: position, playback_id: randomUUID() };
  }
  if (row.state === 'paused' && body.action !== 'pause') fail(409, 'playback_recovery_required');
  if (body.positionMs < Number(row.position_ms) || body.positionMs > Number(recording.duration_ms)) fail(422, 'invalid_playback_position');
  if (body.action === 'complete' && body.positionMs !== Number(recording.duration_ms)) fail(422, 'invalid_playback_position');
  return { state: body.action === 'complete' ? 'completed' : body.action === 'pause' ? 'paused' : 'playing',
    plays_used: Number(row.plays_used), position_ms: body.positionMs, playback_id: row.playback_id };
}

function sqlFault(error) {
  if (error instanceof Fault) throw error;
  const known = ['playback_conflict', 'playback_exhausted', 'playback_recovery_required', 'mock_expired', 'mock_finalised',
    'mock_rights_blocked', 'mock_content_unavailable', 'mock_group_inactive', 'preparation_archived'];
  if (known.includes(error?.message)) fail(409, error.message);
  if (error?.message === 'not_found') fail(404, 'not_found');
  throw error;
}

export function playbackMethods({ settle, catalogue, note = () => {}, mediaRoot }) {
  const transaction = (owner, work) => settle(owner, work).catch(sqlFault);
  async function context(client, owner, runId) {
    // This is also the order used by finalisation and account deletion.
    await lockMockOwner(client, owner);
    const identity = first(await client.query('SELECT preparation_id,exam_id FROM mock_run WHERE id=$1 AND owner_id=$2', [runId, owner]));
    if (!identity) fail(404, 'not_found');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[identity.exam_id]);
    const prep = await requireActivePreparation(client, owner, identity.preparation_id);
    if (!catalogue.isEnabled(prep.exam_id)) fail(422, 'exam_unavailable');
    const run = first(await client.query('SELECT *,clock_timestamp() AS server_now FROM mock_run WHERE id=$1 AND owner_id=$2 FOR UPDATE', [runId, owner]));
    if (!run) fail(404, 'not_found');
    if (run.state !== 'active') fail(409, 'mock_finalised');
    if (run.deadline_at && new Date(run.server_now) >= new Date(run.deadline_at)) fail(409, 'mock_expired');
    const bundle = await readReleasedForm(client, { examId: run.exam_id, formId: run.form_id, formVersion: run.form_version, releaseVersion: run.release_version });
    if (!bundle) fail(409, 'mock_content_unavailable');
    if (bundle.blockedReason) fail(409, bundle.blockedReason === 'rights_blocked' ? 'mock_rights_blocked' : 'mock_content_unavailable');
    const recordings = bundle.members.flatMap(member => member.recordings ?? []);
    return { run, bundle, recordings };
  }
  function member(bundle, recordings, mediaId, version) {
    const recording = recordings.find(r => r.media_id === mediaId && r.media_version === version);
    const media = bundle.media?.find(m => m.media_id === mediaId && m.version === version);
    if (!recording || !media) fail(404, 'not_found');
    const section = bundle.members.find(m => m.recordings?.some(r => r.media_id===mediaId && r.media_version===version))?.section;
    return { recording, media, section };
  }
  async function bytesOf(media) {
    try { return await readMediaBytes(media, { mediaRoot }); }
    catch (error) { fail(409, error?.code === 'media_integrity' || error?.message === 'media_integrity' ? 'media_integrity' : 'media_unavailable'); }
  }
  return {
    async readMockPlayback(owner, runId) {
      note('readMockPlayback');
      return transaction(owner, async client => {
        const { run, recordings } = await context(client, owner, runId);
        const rows = (await client.query('SELECT * FROM listening_playback WHERE owner_id=$1 AND run_id=$2', [owner, runId])).rows;
        return recordings.map(recording => playbackDto(rows.find(r => r.media_id === recording.media_id && r.media_version === recording.media_version), recording, run.server_now));
      });
    },
    async mutateMockPlayback(owner, runId, input) {
      note('mutateMockPlayback'); const body = validatePlaybackEvent(input);
      const sha = createHash('sha256').update(JSON.stringify({ runId, body })).digest('hex');
      return transaction(owner, async client => {
        await lockMockOwner(client,owner);
        const prior=first(await client.query('SELECT * FROM listening_playback_event WHERE owner_id=$1 AND event_id=$2',[owner,body.eventId]));
        if(prior&&(prior.run_id!==runId||prior.request_sha256!==sha))fail(409,'playback_conflict');
        if(prior){
          const saved=first(await client.query('SELECT *,clock_timestamp() AS server_now FROM listening_playback WHERE owner_id=$1 AND run_id=$2 AND media_id=$3 AND media_version=$4',[owner,runId,body.mediaId,body.mediaVersion]));
          if(!saved)fail(404,'not_found');
          return playbackDto(saved,saved,saved.server_now);
        }
        const { run, bundle, recordings } = await context(client, owner, runId);
        const { recording, media, section } = member(bundle, recordings, body.mediaId, body.mediaVersion);
        await requireMockGroup(client,runId,section);
        let row = first(await client.query('SELECT * FROM listening_playback WHERE owner_id=$1 AND run_id=$2 AND media_id=$3 AND media_version=$4 FOR UPDATE', [owner, runId, body.mediaId, body.mediaVersion]));
        if (body.action === 'begin') await bytesOf(media); // A missing/corrupt resource never debits.
        const now = first(await client.query('SELECT clock_timestamp() AS now')).now;
        const next = playbackTransition(row, recording, body, now);
        if (!row) {
          row = first(await client.query(`INSERT INTO listening_playback
            (owner_id,run_id,exam_id,media_id,media_version,max_plays,duration_ms,state,plays_used,position_ms,playback_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [owner,runId,run.exam_id,body.mediaId,body.mediaVersion,recording.max_plays,recording.duration_ms,next.state,next.plays_used,next.position_ms,next.playback_id]));
        } else {
          row = first(await client.query(`UPDATE listening_playback SET state=$5,plays_used=$6,position_ms=$7,playback_id=$8,
            revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND run_id=$2 AND media_id=$3 AND media_version=$4 RETURNING *`,
          [owner,runId,body.mediaId,body.mediaVersion,next.state,next.plays_used,next.position_ms,next.playback_id]));
        }
        await client.query(`INSERT INTO listening_playback_event(owner_id,event_id,run_id,media_id,media_version,request_sha256,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [owner,body.eventId,runId,body.mediaId,body.mediaVersion,sha,row.revision]);
        return playbackDto(row, recording, row.updated_at, false);
      });
    },
    async readMockMedia(owner, runId, mediaId, version) {
      note('readMockMedia');
      return transaction(owner, async client => {
        const { bundle, recordings } = await context(client, owner, runId);
        const { media, section } = member(bundle, recordings, mediaId, version);
        await requireMockGroup(client,runId,section);
        const bytes = await bytesOf(media);
        // Filesystem I/O may take time: recheck current deadline/publication before returning headers.
        await context(client, owner, runId);
        await requireMockGroup(client,runId,section);
        return { bytes, media: { mime_type: media.mime_type, sha256: media.sha256 } };
      });
    },
  };
}

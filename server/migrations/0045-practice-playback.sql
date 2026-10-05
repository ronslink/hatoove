-- PRACTICE-MEDIA (task-17) — the practice-bound listening playback path.
--
-- WHY A SECOND TABLE. `listening_playback` (0030) is bound to a `mock_run` by a composite foreign key and its
-- guard reads that run's form, deadline and `attemptMode`. A practice sitting is not a run: it is untimed, it
-- covers ONE released set of ONE part, and there is no form. Reusing that table would mean rewriting a guard
-- the mock path depends on, so the practice path gets the SAME ACCOUNTING MODEL on its own key instead:
-- per-(sitting, recording) `plays_used`/`max_plays`, the same one-way state machine, the same
-- acknowledged-`begin` + event-id idempotency, and the same integrity-first rule that a missing or corrupt
-- resource never debits a play. `playbackDto`, `playbackTransition`, `recoveryPosition`, `readMediaBytes`
-- and `mediaResponse` are shared with the mock path — this is not a second player.
--
-- THE PRACTICE RULE (the one thing that differs). The allowance is the EXAM allowance for the part's family —
-- the blueprint's `playback->>'mock'` (telc B1: HV1 1, HV2 2, HV3 2), which is the number slice B serves to
-- the learner through `/api/v1/exam-parts` and which the runner displays. On top of that allowance a listener
-- gets exactly ONE play before "Auswerten": every further play requires the sitting to be `checked`. That is
-- why a second listen before Auswerten is refused by the SERVER rather than merely hidden in the client, and
-- it is enforced here as well as in the pure transition, so no caller can skip it.
--
-- WHAT IT IS NOT. No bytes, no key, no explanation: the row is the accounting identity and nothing else.
CREATE TABLE IF NOT EXISTS "__SCHEMA__".practice_playback (
  owner_id       text NOT NULL REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE,
  attempt_id     uuid NOT NULL REFERENCES "__SCHEMA__".practice_attempt(attempt_id) ON DELETE CASCADE,
  exam_id        text NOT NULL,
  media_id       text NOT NULL,
  media_version  text NOT NULL,
  revision       integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  state          text NOT NULL CHECK (state IN ('playing','paused','completed')),
  plays_used     integer NOT NULL CHECK (plays_used > 0),
  max_plays      integer NOT NULL CHECK (max_plays BETWEEN 1 AND 10),
  position_ms    integer NOT NULL CHECK (position_ms >= 0),
  duration_ms    integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 3600000),
  playback_id    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, attempt_id, media_id, media_version),
  CHECK (plays_used <= max_plays AND position_ms <= duration_ms),
  CHECK (state <> 'completed' OR position_ms = duration_ms),
  FOREIGN KEY (media_id, media_version, exam_id)
    REFERENCES "__SCHEMA__".exam_media(media_id, version, exam_id)
);
-- The same idempotency shape as 0030: one accepted request per event id, and a replayed event returns the
-- stored row rather than consuming a second play.
CREATE TABLE IF NOT EXISTS "__SCHEMA__".practice_playback_event (
  owner_id       text NOT NULL,
  event_id       uuid NOT NULL,
  attempt_id     uuid NOT NULL,
  media_id       text NOT NULL,
  media_version  text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision       integer NOT NULL CHECK (revision > 0),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, event_id),
  FOREIGN KEY (owner_id, attempt_id, media_id, media_version)
    REFERENCES "__SCHEMA__".practice_playback(owner_id, attempt_id, media_id, media_version) ON DELETE CASCADE
);

ALTER TABLE "__SCHEMA__".practice_playback ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".practice_playback FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".practice_playback_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".practice_playback_event FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_practice_playback ON "__SCHEMA__".practice_playback TO "__LEARNER__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))
  WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_practice_playback_event ON "__SCHEMA__".practice_playback_event TO "__LEARNER__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))
  WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_practice_playback ON "__SCHEMA__".practice_playback TO "__DELETION__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_practice_playback_event ON "__SCHEMA__".practice_playback_event TO "__DELETION__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
REVOKE ALL ON "__SCHEMA__".practice_playback,"__SCHEMA__".practice_playback_event FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".practice_playback,"__SCHEMA__".practice_playback_event TO "__LEARNER__";
-- Column grants, not table grants: the allowance, the duration and the creation instant can never be
-- rewritten from the runtime role, so a caller cannot widen its own play budget.
GRANT INSERT(owner_id,attempt_id,exam_id,media_id,media_version,state,plays_used,max_plays,position_ms,duration_ms,playback_id)
  ON "__SCHEMA__".practice_playback TO "__LEARNER__";
GRANT UPDATE(revision,state,plays_used,position_ms,playback_id,updated_at)
  ON "__SCHEMA__".practice_playback TO "__LEARNER__";
GRANT INSERT(owner_id,event_id,attempt_id,media_id,media_version,request_sha256,revision)
  ON "__SCHEMA__".practice_playback_event TO "__LEARNER__";
GRANT SELECT,DELETE ON "__SCHEMA__".practice_playback,"__SCHEMA__".practice_playback_event TO "__DELETION__";

-- The migration-owned definer below is still subject to FORCE RLS, and 0044 (already applied, checksum frozen)
-- did not give `practice_attempt` a policy for it — so a plain read returned ZERO rows and every play was
-- refused with `not_found`. This is 0025's own pattern for exactly this situation (`finalise_mock_run ON
-- mock_run TO CURRENT_USER`), added here rather than by editing an applied migration. Owner fencing is
-- retained: the definer sees only the acting learner's rows, never the whole table.
DROP POLICY IF EXISTS practice_playback_sitting ON "__SCHEMA__".practice_attempt;
CREATE POLICY practice_playback_sitting ON "__SCHEMA__".practice_attempt TO CURRENT_USER
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

CREATE OR REPLACE FUNCTION "__SCHEMA__".protect_practice_playback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE
  a practice_attempt%ROWTYPE; prep_state text; instant timestamptz;
  pinned record; policy_count integer; consumes boolean := false; was_checked boolean; is_replay boolean := false;
BEGIN
  IF NEW.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'')
  THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id,7352));
  SELECT * INTO a FROM practice_attempt WHERE attempt_id=NEW.attempt_id AND owner_id=NEW.owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  SELECT state INTO prep_state FROM learner_preparation
    WHERE id=a.preparation_id AND owner_id=NEW.owner_id FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE='23514'; END IF;
  instant:=clock_timestamp();
  was_checked:=a.state='checked';
  -- The recording must be one the SERVED SET actually carries, its duration must be the imported file's, and
  -- the allowance must be the blueprint's EXAM allowance for that part's family. One row or nothing.
  SELECT m.duration_ms, c.review_status, coalesce(cr.basis,c.rights_status) AS rights_status,
         (part.value->'playback'->>'mock')::integer AS max_plays INTO pinned
    FROM objective_set s
    JOIN content_version c ON c.content_version_id=s.content_version_id
    LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id
    JOIN exam_release_head h ON h.exam_id=s.exam_id
    JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version
    JOIN exam_blueprint b ON b.exam_id=r.exam_id AND b.version=r.blueprint_version
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.payload->'recordings','[]'::jsonb)) recording
    JOIN exam_media m ON m.media_id=recording.value->>'mediaId'
      AND m.version=recording.value->>'mediaVersion' AND m.exam_id=s.exam_id
    CROSS JOIN LATERAL jsonb_array_elements(b.payload->'sections') section
    CROSS JOIN LATERAL jsonb_array_elements(section.value->'parts') part
    WHERE s.set_id=a.set_id AND s.version=a.version AND s.exam_id=a.exam_id
      AND part.value->>'family'=s.family AND part.value->>'mediaRequired'='true'
      AND m.media_id=NEW.media_id AND m.version=NEW.media_version;
  GET DIAGNOSTICS policy_count=ROW_COUNT;
  IF policy_count<>1 OR NEW.exam_id<>a.exam_id OR NEW.duration_ms IS DISTINCT FROM pinned.duration_ms
    OR NEW.max_plays IS DISTINCT FROM pinned.max_plays
  THEN RAISE EXCEPTION 'invalid_playback_identity' USING ERRCODE='23514'; END IF;
  IF pinned.rights_status NOT IN ('generated','licensed','commissioned')
    OR pinned.review_status NOT IN ('approved','unreviewed')
  THEN RAISE EXCEPTION 'practice_rights_blocked' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'playing' OR NEW.plays_used<>1 OR NEW.position_ms<>0 OR NEW.revision<>1
    THEN RAISE EXCEPTION 'playback_conflict' USING ERRCODE='23514'; END IF;
    -- The FIRST play of this recording is always allowed, whether or not the learner has already answered:
    -- answering without listening must not cost them the play. It is the SECOND that needs "Auswerten".
    NEW.created_at:=instant;
    consumes:=true;
  ELSE
    IF ROW(NEW.owner_id,NEW.attempt_id,NEW.exam_id,NEW.media_id,NEW.media_version,NEW.max_plays,NEW.duration_ms,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.owner_id,OLD.attempt_id,OLD.exam_id,OLD.media_id,OLD.media_version,OLD.max_plays,OLD.duration_ms,OLD.created_at)
      OR NEW.revision<>OLD.revision+1
    THEN RAISE EXCEPTION 'playback_conflict' USING ERRCODE='23514'; END IF;
    IF OLD.state='completed' THEN
      IF NEW.plays_used<>OLD.plays_used+1 OR NEW.plays_used>OLD.max_plays OR NEW.state<>'playing'
        OR NEW.position_ms<>0 OR NEW.playback_id=OLD.playback_id
      THEN RAISE EXCEPTION 'playback_exhausted' USING ERRCODE='23514'; END IF;
      -- Every play after the first is a REPLAY: it needs "Auswerten" to have happened. This is the rule the
      -- server enforces rather than leaving it to the client, and the reason a second listen before
      -- Auswerten is refused even when the exam allowance would still permit a play.
      IF NOT was_checked THEN RAISE EXCEPTION 'practice_check_required' USING ERRCODE='23514'; END IF;
      consumes:=true; is_replay:=true;
    ELSE
      IF NEW.plays_used<>OLD.plays_used OR NEW.position_ms<OLD.position_ms
      THEN RAISE EXCEPTION 'playback_conflict' USING ERRCODE='23514'; END IF;
      IF NEW.playback_id<>OLD.playback_id THEN
        -- Recovery keeps the consumed play. Only the server chooses the uncertain return position.
        NEW.position_ms:=least(OLD.duration_ms::numeric,OLD.position_ms+CASE WHEN OLD.state='playing'
          THEN greatest(0,floor(extract(epoch FROM instant-OLD.updated_at)*1000)) ELSE 0 END)::integer;
        NEW.state:=CASE WHEN NEW.position_ms=OLD.duration_ms THEN 'completed' ELSE 'playing' END;
      ELSIF OLD.state='paused' AND NEW.state<>'paused' THEN
        RAISE EXCEPTION 'playback_recovery_required' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  -- The sitting's own view (0044 reserved `plays_used`/`replay_used` for this). `replay_used` records that a
  -- play BEYOND the first was consumed on a checked sitting; the parent guard freezes the answer counts of a
  -- checked sitting but not these two, which is exactly why they can still move after Auswerten.
  IF consumes THEN
    UPDATE practice_attempt SET plays_used=plays_used+1, replay_used=(replay_used OR is_replay)
      WHERE attempt_id=NEW.attempt_id AND owner_id=NEW.owner_id;
  END IF;
  NEW.updated_at:=instant;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_practice_playback() FROM PUBLIC;
DROP TRIGGER IF EXISTS practice_playback_protect ON "__SCHEMA__".practice_playback;
CREATE TRIGGER practice_playback_protect BEFORE INSERT OR UPDATE ON "__SCHEMA__".practice_playback
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_practice_playback();

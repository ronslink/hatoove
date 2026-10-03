-- EXAM-S5A: playback revisions are independent of response autosave revisions.
-- Missing playback rows mean ready/zero uses. Only an acknowledged begin inserts a row.
CREATE TABLE "__SCHEMA__".listening_playback (
  owner_id text NOT NULL REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  exam_id text NOT NULL,
  media_id text NOT NULL,
  media_version text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('playing','paused','completed')),
  plays_used integer NOT NULL CHECK (plays_used > 0),
  max_plays integer NOT NULL CHECK (max_plays BETWEEN 1 AND 10),
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 3600000),
  playback_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,run_id,media_id,media_version),
  CHECK (plays_used <= max_plays AND position_ms <= duration_ms),
  CHECK (state <> 'completed' OR position_ms = duration_ms),
  FOREIGN KEY(run_id,owner_id) REFERENCES "__SCHEMA__".mock_run(id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(media_id,media_version,exam_id) REFERENCES "__SCHEMA__".exam_media(media_id,version,exam_id)
);
CREATE TABLE "__SCHEMA__".listening_playback_event (
  owner_id text NOT NULL,
  event_id uuid NOT NULL,
  run_id uuid NOT NULL,
  media_id text NOT NULL,
  media_version text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,event_id),
  FOREIGN KEY(owner_id,run_id,media_id,media_version)
    REFERENCES "__SCHEMA__".listening_playback(owner_id,run_id,media_id,media_version) ON DELETE CASCADE
);
ALTER TABLE "__SCHEMA__".listening_playback ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".listening_playback FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".listening_playback_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".listening_playback_event FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_listening_playback ON "__SCHEMA__".listening_playback TO "__LEARNER__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))
  WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_listening_playback_event ON "__SCHEMA__".listening_playback_event TO "__LEARNER__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))
  WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_listening_playback ON "__SCHEMA__".listening_playback TO "__DELETION__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_listening_playback_event ON "__SCHEMA__".listening_playback_event TO "__DELETION__"
  USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
REVOKE ALL ON "__SCHEMA__".listening_playback,"__SCHEMA__".listening_playback_event FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".listening_playback,"__SCHEMA__".listening_playback_event TO "__LEARNER__";
GRANT INSERT(owner_id,run_id,exam_id,media_id,media_version,state,plays_used,max_plays,position_ms,duration_ms,playback_id)
  ON "__SCHEMA__".listening_playback TO "__LEARNER__";
GRANT UPDATE(revision,state,plays_used,position_ms,playback_id,updated_at) ON "__SCHEMA__".listening_playback TO "__LEARNER__";
GRANT INSERT(owner_id,event_id,run_id,media_id,media_version,request_sha256,revision)
  ON "__SCHEMA__".listening_playback_event TO "__LEARNER__";
GRANT SELECT,DELETE ON "__SCHEMA__".listening_playback,"__SCHEMA__".listening_playback_event TO "__DELETION__";

CREATE FUNCTION "__SCHEMA__".protect_listening_playback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE
  r mock_run%ROWTYPE; prep_id uuid; prep_state text; head_version text; head_manifest jsonb;
  pinned record; policy_count integer; instant timestamptz;
BEGIN
  IF NEW.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'')
  THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id,7352));
  SELECT preparation_id INTO prep_id FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  SELECT state INTO prep_state FROM learner_preparation WHERE id=prep_id AND owner_id=NEW.owner_id FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE='23514'; END IF;
  SELECT * INTO r FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id FOR UPDATE;
  IF r.state<>'active' THEN RAISE EXCEPTION 'mock_finalised' USING ERRCODE='23514'; END IF;
  instant:=clock_timestamp();
  IF r.deadline_at IS NOT NULL AND instant>=r.deadline_at THEN RAISE EXCEPTION 'mock_expired' USING ERRCODE='23514'; END IF;
  SELECT release_version INTO head_version FROM exam_release_head WHERE exam_id=r.exam_id FOR SHARE;
  SELECT manifest INTO head_manifest FROM exam_release WHERE exam_id=r.exam_id AND version=head_version;
  IF coalesce(head_manifest#>'{release,resumeBlockedReleases}','[]'::jsonb) ? r.release_version
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE='23514'; END IF;
  SELECT m.duration_ms,c.review_status,coalesce(cr.basis,c.rights_status) AS rights_status,
    (part.value->'playback'->>(form.payload->>'attemptMode'))::integer AS max_plays INTO pinned
    FROM exam_form form JOIN exam_form_member f ON f.exam_id=form.exam_id AND f.form_id=form.form_id AND f.form_version=form.version
    JOIN objective_set s ON s.set_id=f.set_id AND s.version=f.set_version AND s.exam_id=f.exam_id
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'recordings') recording
    JOIN exam_media m ON m.media_id=recording.value->>'mediaId' AND m.version=recording.value->>'mediaVersion' AND m.exam_id=f.exam_id
    JOIN content_version c ON c.content_version_id=m.content_version_id
    LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id
    JOIN exam_blueprint b ON b.exam_id=form.exam_id AND b.version=form.blueprint_version
    CROSS JOIN LATERAL jsonb_array_elements(b.payload->'sections') section
    CROSS JOIN LATERAL jsonb_array_elements(section.value->'parts') part
    WHERE form.exam_id=r.exam_id AND form.form_id=r.form_id AND form.version=r.form_version
      AND f.interaction='fixed_audio' AND part.value->>'family'=s.family AND m.media_id=NEW.media_id AND m.version=NEW.media_version;
  GET DIAGNOSTICS policy_count=ROW_COUNT;
  IF policy_count<>1 OR NEW.exam_id<>r.exam_id OR NEW.duration_ms IS DISTINCT FROM pinned.duration_ms
    OR NEW.max_plays IS DISTINCT FROM pinned.max_plays
  THEN RAISE EXCEPTION 'invalid_playback_identity' USING ERRCODE='23514'; END IF;
  IF pinned.rights_status NOT IN ('generated','licensed','commissioned') OR pinned.review_status NOT IN ('approved','unreviewed')
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'playing' OR NEW.plays_used<>1 OR NEW.position_ms<>0 OR NEW.revision<>1
    THEN RAISE EXCEPTION 'playback_conflict' USING ERRCODE='23514'; END IF;
    NEW.created_at:=instant;
  ELSE
    IF ROW(NEW.owner_id,NEW.run_id,NEW.exam_id,NEW.media_id,NEW.media_version,NEW.max_plays,NEW.duration_ms,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.owner_id,OLD.run_id,OLD.exam_id,OLD.media_id,OLD.media_version,OLD.max_plays,OLD.duration_ms,OLD.created_at)
      OR NEW.revision<>OLD.revision+1
    THEN RAISE EXCEPTION 'playback_conflict' USING ERRCODE='23514'; END IF;
    IF OLD.state='completed' THEN
      IF NEW.plays_used<>OLD.plays_used+1 OR NEW.plays_used>OLD.max_plays OR NEW.state<>'playing'
        OR NEW.position_ms<>0 OR NEW.playback_id=OLD.playback_id
      THEN RAISE EXCEPTION 'playback_exhausted' USING ERRCODE='23514'; END IF;
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
  NEW.updated_at:=instant;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_listening_playback() FROM PUBLIC;
CREATE TRIGGER protect_listening_playback BEFORE INSERT OR UPDATE ON "__SCHEMA__".listening_playback
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_listening_playback();

-- Extend ordered question traversal, preserving S4 writing-only finalisation.
CREATE OR REPLACE FUNCTION "__SCHEMA__".protect_mock_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  form_payload jsonb; form_blueprint text; release_blueprint text; prep_state text;
  member_row record; item_row jsonb; response_row jsonb; item_id text; choices jsonb;
  tuples text[] := ARRAY[]::text[]; response_tuple text; item_array jsonb;
  head_version text; head_manifest jsonb; head_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'finalised' THEN RAISE EXCEPTION 'mock_finalised' USING ERRCODE = '23514'; END IF;
    IF ROW(NEW.id, NEW.owner_id, NEW.preparation_id, NEW.exam_id, NEW.release_version, NEW.blueprint_version,
      NEW.form_id, NEW.form_version, NEW.start_event_id, NEW.title, NEW.scope, NEW.mode, NEW.created_at, NEW.deadline_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.preparation_id, OLD.exam_id, OLD.release_version, OLD.blueprint_version,
      OLD.form_id, OLD.form_version, OLD.start_event_id, OLD.title, OLD.scope, OLD.mode, OLD.created_at, OLD.deadline_at)
    THEN RAISE EXCEPTION 'mock_identity_immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'mock_revision' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'active' AND OLD.deadline_at IS NOT NULL AND clock_timestamp() >= OLD.deadline_at
    THEN RAISE EXCEPTION 'mock_expired' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'finalised' AND (NEW.responses IS DISTINCT FROM OLD.responses OR NEW.position IS DISTINCT FROM OLD.position)
    THEN RAISE EXCEPTION 'mock_finalise_saved_only' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT state INTO prep_state FROM learner_preparation
    WHERE id = NEW.preparation_id AND owner_id = NEW.owner_id AND exam_id = NEW.exam_id FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE = '23514'; END IF;
  -- Runtime has no UPDATE privilege on the publication pointer, so only this narrow trigger takes
  -- its share lock. A concurrent privileged withdrawal either precedes the write or waits for it.
  SELECT h.release_version INTO head_version FROM exam_release_head h
    WHERE h.exam_id = NEW.exam_id FOR SHARE;
  -- Read the manifest after obtaining the pointer lock, so a head update that won the lock race
  -- cannot be paired with the previous release's joined snapshot by READ COMMITTED rechecking.
  SELECT manifest,state INTO head_manifest,head_state FROM exam_release
    WHERE exam_id = NEW.exam_id AND version = head_version;
  IF coalesce(head_manifest #> '{release,resumeBlockedReleases}', '[]'::jsonb) ? NEW.release_version
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND (head_version IS DISTINCT FROM NEW.release_version OR head_state NOT IN ('internal','available'))
  THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE = '23514'; END IF;
  SELECT payload, blueprint_version INTO form_payload, form_blueprint FROM exam_form
    WHERE exam_id = NEW.exam_id AND form_id = NEW.form_id AND version = NEW.form_version;
  SELECT blueprint_version INTO release_blueprint FROM exam_release
    WHERE exam_id = NEW.exam_id AND version = NEW.release_version;
  IF NEW.blueprint_version IS DISTINCT FROM form_blueprint OR NEW.blueprint_version IS DISTINCT FROM release_blueprint
  THEN RAISE EXCEPTION 'mock_blueprint_mismatch' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.title := form_payload->>'title'; NEW.scope := form_payload->>'scope'; NEW.mode := form_payload->>'mode';
    IF form_payload->>'timeLimitSeconds' IS NOT NULL THEN
      NEW.deadline_at := NEW.created_at + make_interval(secs => (form_payload->>'timeLimitSeconds')::integer);
    END IF;
  END IF;
  IF NEW.position->>'member' !~ '^[0-9]+$' OR NEW.position->>'item' !~ '^[0-9]+$'
    OR NOT (NEW.position ?& ARRAY['member', 'item'])
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.position)) <> 2
    OR NOT ((jsonb_array_length(coalesce(form_payload->'members','[]'::jsonb))=0 AND jsonb_array_length(coalesce(form_payload->'writingChoices','[]'::jsonb))=1 AND NEW.position=' {"member":0,"item":0}'::jsonb) OR EXISTS (SELECT 1 FROM exam_form_member f WHERE f.exam_id = NEW.exam_id AND f.form_id = NEW.form_id
      AND f.form_version = NEW.form_version AND f.position = (NEW.position->>'member')::integer
      AND (NEW.position->>'item')::integer < f.item_count))
  THEN RAISE EXCEPTION 'invalid_mock_position' USING ERRCODE = '23514'; END IF;
  FOR response_row IN SELECT value FROM jsonb_array_elements(NEW.responses) LOOP
    IF jsonb_typeof(response_row) <> 'object' OR NOT (response_row ?& ARRAY['setId','version','itemId','answer'])
      OR (SELECT count(*) FROM jsonb_object_keys(response_row)) <> 4
      OR jsonb_typeof(response_row->'setId') <> 'string'
      OR jsonb_typeof(response_row->'version') <> 'string'
      OR jsonb_typeof(response_row->'itemId') <> 'string'
    THEN RAISE EXCEPTION 'invalid_mock_response' USING ERRCODE = '23514'; END IF;
    response_tuple := jsonb_build_array(response_row->>'setId', response_row->>'version', response_row->>'itemId')::text;
    IF response_tuple = ANY(tuples) THEN RAISE EXCEPTION 'duplicate_mock_response' USING ERRCODE = '23514'; END IF;
    tuples := array_append(tuples, response_tuple);
    SELECT f.interaction, s.payload INTO member_row FROM exam_form_member f
      JOIN objective_set s ON s.set_id = f.set_id AND s.version = f.set_version AND s.exam_id = f.exam_id
      WHERE f.exam_id = NEW.exam_id AND f.form_id = NEW.form_id AND f.form_version = NEW.form_version
        AND f.set_id = response_row->>'setId' AND f.set_version = response_row->>'version';
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_mock_item' USING ERRCODE = '23514'; END IF;
    item_array := CASE WHEN member_row.interaction IN ('grouped_choice','fixed_audio') THEN (SELECT coalesce(jsonb_agg(q.value ORDER BY g.ordinality,q.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(member_row.payload->CASE WHEN member_row.interaction='fixed_audio' THEN 'recordings' ELSE 'groups' END) WITH ORDINALITY g
        CROSS JOIN LATERAL jsonb_array_elements(g.value->'questions') WITH ORDINALITY q)
      ELSE member_row.payload -> CASE member_row.interaction WHEN 'matching_headlines' THEN 'texts'
      WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' ELSE 'gaps' END END;
    SELECT value INTO item_row FROM jsonb_array_elements(item_array)
      WHERE coalesce(value->>'id', value->>'n') = response_row->>'itemId';
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_mock_item' USING ERRCODE = '23514'; END IF;
    IF response_row->'answer' <> 'null'::jsonb THEN
      IF jsonb_typeof(response_row->'answer') <> 'string' THEN RAISE EXCEPTION 'invalid_mock_answer' USING ERRCODE = '23514'; END IF;
      IF member_row.interaction IN ('single_choice','gap_choice','grouped_choice','fixed_audio') THEN
        IF NOT (coalesce(item_row->'options', '{}'::jsonb) ? (response_row->>'answer'))
        THEN RAISE EXCEPTION 'invalid_mock_answer' USING ERRCODE = '23514'; END IF;
      ELSE
        choices := member_row.payload -> CASE member_row.interaction WHEN 'matching_headlines' THEN 'headlines'
          WHEN 'matching_ads' THEN 'ads' WHEN 'gap_bank' THEN 'bank' ELSE 'unsupported' END;
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(choices) WHERE value->>'id' = response_row->>'answer')
          AND NOT (member_row.interaction = 'matching_ads' AND response_row->>'answer' = 'x')
        THEN RAISE EXCEPTION 'invalid_mock_answer' USING ERRCODE = '23514'; END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_mock_run() FROM PUBLIC;

CREATE OR REPLACE FUNCTION "__SCHEMA__".finalise_mock_run(p_id uuid, p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  who text := nullif(current_setting('hatoove.owner_id', true), '');
  run_row mock_run%ROWTYPE; prep_id uuid; prep_state text; member_row record;
  item_row jsonb; item_array jsonb; item_id text; answer jsonb; expected jsonb; explanation jsonb;
  all_items jsonb := '[]'; saved_result jsonb; marked boolean;
  answered_count integer := 0; correct_count integer := 0; total_count integer := 0;
BEGIN
  IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  -- Same lock order as the adapter and deletion: owner gate, preparation, then run.
  PERFORM pg_advisory_xact_lock(hashtextextended(who, 7352));
  SELECT preparation_id INTO prep_id FROM mock_run WHERE id = p_id AND owner_id = who;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT state INTO prep_state FROM learner_preparation WHERE id = prep_id AND owner_id = who FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO run_row FROM mock_run WHERE id = p_id AND owner_id = who FOR UPDATE;
  IF EXISTS (SELECT 1 FROM exam_release_head h JOIN exam_release e ON e.exam_id = h.exam_id AND e.version = h.release_version
    WHERE h.exam_id = run_row.exam_id AND coalesce(e.manifest #> '{release,resumeBlockedReleases}', '[]'::jsonb) ? run_row.release_version)
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE = 'P0001'; END IF;
  IF run_row.state = 'finalised' THEN RETURN run_row.result; END IF;
  IF run_row.revision <> p_revision THEN RAISE EXCEPTION 'mock_conflict' USING ERRCODE = 'P0001'; END IF;
  FOR member_row IN SELECT f.*, s.payload, s.family, s.section, k.answers, k.explanations
    FROM exam_form_member f JOIN objective_set s ON s.set_id = f.set_id AND s.version = f.set_version AND s.exam_id = f.exam_id
    JOIN objective_key k ON k.set_id = f.set_id AND k.version = f.set_version
    WHERE f.exam_id = run_row.exam_id AND f.form_id = run_row.form_id AND f.form_version = run_row.form_version ORDER BY f.position LOOP
    item_array := CASE WHEN member_row.interaction IN ('grouped_choice','fixed_audio') THEN (SELECT coalesce(jsonb_agg(q.value ORDER BY g.ordinality,q.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(member_row.payload->CASE WHEN member_row.interaction='fixed_audio' THEN 'recordings' ELSE 'groups' END) WITH ORDINALITY g
        CROSS JOIN LATERAL jsonb_array_elements(g.value->'questions') WITH ORDINALITY q)
      ELSE member_row.payload -> CASE member_row.interaction WHEN 'matching_headlines' THEN 'texts'
        WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' ELSE 'gaps' END END;
    FOR item_row IN SELECT value FROM jsonb_array_elements(item_array) LOOP
      item_id := coalesce(item_row->>'id', item_row->>'n');
      expected := member_row.answers -> item_id;
      IF expected IS NULL THEN RAISE EXCEPTION 'unknown_item' USING ERRCODE = 'P0002'; END IF;
      SELECT value->'answer' INTO answer FROM jsonb_array_elements(run_row.responses)
        WHERE value->>'setId' = member_row.set_id AND value->>'version' = member_row.set_version AND value->>'itemId' = item_id;
      answer := coalesce(answer, 'null'::jsonb);
      marked := answer <> 'null'::jsonb AND answer = expected;
      explanation := coalesce(member_row.explanations -> item_id, member_row.explanations #> ARRAY['_set_why',item_id], 'null'::jsonb);
      total_count := total_count + 1;
      IF answer <> 'null'::jsonb THEN answered_count := answered_count + 1; END IF;
      IF marked THEN correct_count := correct_count + 1; END IF;
      all_items := all_items || jsonb_build_array(jsonb_build_object('set_id',member_row.set_id,'version',member_row.set_version,
        'item_id',item_id,'answer',answer,'correct',marked,'unanswered',answer = 'null'::jsonb,
        'correct_answer',expected,'explanation',explanation));
    END LOOP;
  END LOOP;
  IF total_count <> (SELECT coalesce(sum(item_count),0) FROM exam_form_member WHERE exam_id = run_row.exam_id
    AND form_id = run_row.form_id AND form_version = run_row.form_version) OR (total_count = 0 AND NOT EXISTS (SELECT 1 FROM exam_form WHERE exam_id=run_row.exam_id AND form_id=run_row.form_id AND version=run_row.form_version AND jsonb_array_length(coalesce(payload->'writingChoices','[]'::jsonb))=1))
  THEN RAISE EXCEPTION 'invalid_mock_form' USING ERRCODE = '23514'; END IF;
  saved_result := jsonb_build_object('items',all_items,'answered',answered_count,'unanswered',total_count-answered_count,
    'correct',correct_count,'total',total_count);
  IF total_count=0 THEN saved_result:=NULL; END IF;
  UPDATE mock_run SET state = 'finalised', result = saved_result, finalised_at = clock_timestamp(),
    updated_at = clock_timestamp(), revision = revision + 1 WHERE id = p_id AND owner_id = who;
  INSERT INTO item_evidence(evidence_id,owner_id,exam_id,preparation_id,set_id,version,item_id,family,section,answer,correct,mock_run_id)
    SELECT gen_random_uuid(), who, run_row.exam_id, run_row.preparation_id, i->>'set_id', i->>'version',i->>'item_id',
      s.family,s.section,i->'answer',(i->>'correct')::boolean,p_id
    FROM jsonb_array_elements(all_items) i JOIN objective_set s ON s.set_id = i->>'set_id' AND s.version = i->>'version'
    WHERE (i->>'unanswered')::boolean = false;
  RETURN saved_result;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".finalise_mock_run(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".finalise_mock_run(uuid, integer) TO "__LEARNER__";

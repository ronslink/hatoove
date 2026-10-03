-- EXAM-S4: additive imported writing metadata and owned attachments. No learner rows rewritten.
ALTER TABLE "__SCHEMA__".rubric_version ALTER COLUMN max_total DROP NOT NULL;
ALTER TABLE "__SCHEMA__".rubric_version ADD COLUMN policy text;
ALTER TABLE "__SCHEMA__".rubric_version ADD COLUMN feedback_kind text;
ALTER TABLE "__SCHEMA__".task_version ADD COLUMN section text;
ALTER TABLE "__SCHEMA__".mock_run DROP CONSTRAINT mock_run_state_result;
ALTER TABLE "__SCHEMA__".mock_run ADD CONSTRAINT mock_run_state_result CHECK
 ((state='active' AND result IS NULL AND finalised_at IS NULL) OR (state='finalised' AND finalised_at IS NOT NULL));
ALTER TABLE "__SCHEMA__".mock_run_event DROP CONSTRAINT mock_run_event_kind_check;
ALTER TABLE "__SCHEMA__".mock_run_event ADD CONSTRAINT mock_run_event_kind_check CHECK(kind IN ('start','save','finalise','writing_choice'));
CREATE TABLE "__SCHEMA__".mock_writing (
 run_id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 attempt_id uuid NOT NULL UNIQUE REFERENCES "__SCHEMA__".attempts(id),
 choice_group_id text NOT NULL,
 selected_option_id text NOT NULL CHECK(selected_option_id IN ('A','B')),
 submission_id uuid UNIQUE REFERENCES "__SCHEMA__".submissions(id),
 failure_code text CHECK(failure_code IN ('empty_submission','allowance_exhausted')),
 FOREIGN KEY(run_id,owner_id) REFERENCES "__SCHEMA__".mock_run(id,owner_id) ON DELETE CASCADE
);
ALTER TABLE "__SCHEMA__".mock_writing ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".mock_writing FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_mock_writing ON "__SCHEMA__".mock_writing TO "__LEARNER__" USING(owner_id=nullif(current_setting('hatoove.owner_id',true),'')) WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY worker_mock_writing ON "__SCHEMA__".mock_writing TO "__WORKER__" USING(true);
CREATE POLICY deletion_mock_writing ON "__SCHEMA__".mock_writing TO "__DELETION__" USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY worker_mock_run ON "__SCHEMA__".mock_run TO "__WORKER__" USING(true);
GRANT SELECT ON "__SCHEMA__".mock_run TO "__WORKER__";
REVOKE ALL ON "__SCHEMA__".mock_writing FROM PUBLIC;
GRANT SELECT,INSERT ON "__SCHEMA__".mock_writing TO "__LEARNER__";
GRANT UPDATE(submission_id,failure_code) ON "__SCHEMA__".mock_writing TO "__LEARNER__";
GRANT SELECT,DELETE ON "__SCHEMA__".mock_writing TO "__DELETION__";
GRANT SELECT ON "__SCHEMA__".mock_writing,"__SCHEMA__".task_version,"__SCHEMA__".rubric_version,"__SCHEMA__".content_version,"__SCHEMA__".content_rights,
 "__SCHEMA__".exam_release,"__SCHEMA__".exam_release_head,"__SCHEMA__".exam_release_form,"__SCHEMA__".exam_form TO "__WORKER__";
CREATE FUNCTION "__SCHEMA__".protect_mock_writing() RETURNS trigger LANGUAGE plpgsql SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE r mock_run%ROWTYPE; a attempts%ROWTYPE; matched boolean;
BEGIN
 SELECT * INTO r FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id;
 SELECT * INTO a FROM attempts WHERE id=NEW.attempt_id AND owner_id=NEW.owner_id;
 IF r.id IS NULL OR a.id IS NULL OR a.deleted_at IS NOT NULL OR a.exam_id<>r.exam_id OR a.preparation_id<>r.preparation_id OR a.parent_submission_id IS NOT NULL
 THEN RAISE EXCEPTION 'invalid_mock_writing' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF r.state<>'active' THEN RAISE EXCEPTION 'mock_finalised' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT 1 FROM exam_form f CROSS JOIN LATERAL jsonb_array_elements(f.payload->'writingChoices') g
   CROSS JOIN LATERAL jsonb_array_elements(g->'options') o WHERE f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.version=r.form_version
   AND g->>'id'=NEW.choice_group_id AND o->>'id'=NEW.selected_option_id AND o->>'taskId'=a.task_id AND o->>'taskVersion'=a.task_version) INTO matched;
  IF NOT matched OR NEW.submission_id IS NOT NULL OR NEW.failure_code IS NOT NULL THEN RAISE EXCEPTION 'invalid_mock_writing' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.owner_id,NEW.attempt_id,NEW.choice_group_id,NEW.selected_option_id) IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_id,OLD.attempt_id,OLD.choice_group_id,OLD.selected_option_id)
    OR OLD.submission_id IS NOT NULL OR r.state<>'finalised'
    OR NOT EXISTS(SELECT 1 FROM submissions s WHERE s.id=NEW.submission_id AND s.owner_id=NEW.owner_id AND s.attempt_id=NEW.attempt_id)
  THEN RAISE EXCEPTION 'mock_writing_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_mock_writing() FROM PUBLIC;
CREATE TRIGGER protect_mock_writing BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_writing FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_writing();

-- EXAM-S3: extend ordered item traversal only. Existing ownership, exact-version,
-- publication locks, finalisation boundaries and restricted grants remain unchanged.

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
    item_array := CASE WHEN member_row.interaction = 'grouped_choice' THEN (SELECT coalesce(jsonb_agg(q.value ORDER BY g.ordinality,q.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(member_row.payload->'groups') WITH ORDINALITY g
        CROSS JOIN LATERAL jsonb_array_elements(g.value->'questions') WITH ORDINALITY q)
      ELSE member_row.payload -> CASE member_row.interaction WHEN 'matching_headlines' THEN 'texts'
      WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' ELSE 'gaps' END END;
    SELECT value INTO item_row FROM jsonb_array_elements(item_array)
      WHERE coalesce(value->>'id', value->>'n') = response_row->>'itemId';
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_mock_item' USING ERRCODE = '23514'; END IF;
    IF response_row->'answer' <> 'null'::jsonb THEN
      IF jsonb_typeof(response_row->'answer') <> 'string' THEN RAISE EXCEPTION 'invalid_mock_answer' USING ERRCODE = '23514'; END IF;
      IF member_row.interaction IN ('single_choice','gap_choice','grouped_choice') THEN
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
    item_array := CASE WHEN member_row.interaction = 'grouped_choice' THEN (SELECT coalesce(jsonb_agg(q.value ORDER BY g.ordinality,q.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(member_row.payload->'groups') WITH ORDINALITY g
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

-- Attached attempts cannot bypass mock finalisation through the ordinary writing SQL grants.
CREATE FUNCTION "__SCHEMA__".protect_attached_writing() RETURNS trigger LANGUAGE plpgsql SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE aid uuid; r mock_run%ROWTYPE; direct_attachment boolean;
BEGIN
 IF current_user='__DELETION__' THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 aid:=CASE WHEN TG_TABLE_NAME='attempts' THEN (to_jsonb(OLD)->>'id')::uuid WHEN TG_OP='DELETE' THEN (to_jsonb(OLD)->>'attempt_id')::uuid ELSE (to_jsonb(NEW)->>'attempt_id')::uuid END;
 SELECT EXISTS(SELECT 1 FROM mock_writing WHERE attempt_id=aid) INTO direct_attachment;
 WITH RECURSIVE lineage AS (
   SELECT id,parent_submission_id FROM attempts WHERE id=aid
   UNION ALL SELECT a.id,a.parent_submission_id FROM lineage l JOIN submissions s ON s.id=l.parent_submission_id JOIN attempts a ON a.id=s.attempt_id
 ) SELECT mr.* INTO r FROM lineage l JOIN mock_writing w ON w.attempt_id=l.id JOIN mock_run mr ON mr.id=w.run_id AND mr.owner_id=w.owner_id LIMIT 1;
 IF FOUND THEN
  IF direct_attachment THEN
  IF TG_TABLE_NAME='attempts' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'attached_mock_attempt' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='submissions' AND r.state<>'finalised' THEN RAISE EXCEPTION 'attached_mock_attempt' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='drafts' AND r.state='finalised' THEN RAISE EXCEPTION 'mock_finalised' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='drafts' AND r.deadline_at IS NOT NULL AND clock_timestamp()>=r.deadline_at THEN RAISE EXCEPTION 'mock_expired' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM exam_release_head h JOIN exam_release e ON e.exam_id=h.exam_id AND e.version=h.release_version WHERE h.exam_id=r.exam_id
    AND coalesce(e.manifest #> '{release,resumeBlockedReleases}','[]'::jsonb) ? r.release_version)
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_attached_writing() FROM PUBLIC;
CREATE TRIGGER protect_attached_attempt BEFORE UPDATE OF deleted_at OR DELETE ON "__SCHEMA__".attempts FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_attached_writing();
CREATE TRIGGER protect_attached_draft BEFORE UPDATE OR DELETE ON "__SCHEMA__".drafts FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_attached_writing();
CREATE TRIGGER protect_attached_submission BEFORE INSERT ON "__SCHEMA__".submissions FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_attached_writing();

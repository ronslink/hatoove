-- EXAM-S2. New owned records only; standalone evidence, preparations and balances are unchanged.
-- Runtime cannot update identity or finalisation columns, or SELECT objective_key. The one definer
-- below freezes the saved snapshot, produces its feedback, and appends exact-version evidence atomically.

CREATE TABLE "__SCHEMA__".mock_run (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE,
  preparation_id uuid NOT NULL,
  exam_id text NOT NULL,
  release_version text NOT NULL,
  blueprint_version text NOT NULL,
  form_id text NOT NULL,
  form_version text NOT NULL,
  start_event_id uuid NOT NULL,
  title text NOT NULL,
  scope text NOT NULL,
  mode text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'finalised')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  responses jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(responses) = 'array' AND jsonb_array_length(responses) <= 500),
  position jsonb NOT NULL DEFAULT '{"member":0,"item":0}' CHECK (jsonb_typeof(position) = 'object'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz,
  finalised_at timestamptz,
  CONSTRAINT mock_run_state_result CHECK ((state = 'active' AND result IS NULL AND finalised_at IS NULL)
    OR (state = 'finalised' AND result IS NOT NULL AND finalised_at IS NOT NULL)),
  CONSTRAINT mock_run_start_event UNIQUE (owner_id, start_event_id),
  CONSTRAINT mock_run_owner_identity UNIQUE (id, owner_id),
  CONSTRAINT mock_run_context_identity UNIQUE (id, owner_id, exam_id, preparation_id),
  CONSTRAINT mock_run_preparation_fk FOREIGN KEY (preparation_id, owner_id, exam_id)
    REFERENCES "__SCHEMA__".learner_preparation(id, owner_id, exam_id),
  CONSTRAINT mock_run_blueprint_fk FOREIGN KEY (exam_id, blueprint_version)
    REFERENCES "__SCHEMA__".exam_blueprint(exam_id, version),
  CONSTRAINT mock_run_form_fk FOREIGN KEY (exam_id, form_id, form_version)
    REFERENCES "__SCHEMA__".exam_form(exam_id, form_id, version),
  CONSTRAINT mock_run_release_form_fk FOREIGN KEY (exam_id, release_version, form_id, form_version)
    REFERENCES "__SCHEMA__".exam_release_form(exam_id, release_version, form_id, form_version)
);
CREATE INDEX mock_run_owner_preparation_idx ON "__SCHEMA__".mock_run(owner_id, preparation_id, created_at DESC, id);

-- Receipts are transport metadata, owned and deletable, but excluded from learner-content export.
CREATE TABLE "__SCHEMA__".mock_run_event (
  owner_id text NOT NULL REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('start', 'save', 'finalise')),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, event_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES "__SCHEMA__".mock_run(id, owner_id) ON DELETE CASCADE
);
ALTER TABLE "__SCHEMA__".item_evidence ADD COLUMN mock_run_id uuid;
ALTER TABLE "__SCHEMA__".item_evidence ADD CONSTRAINT item_evidence_mock_run_fk
  FOREIGN KEY (mock_run_id, owner_id, exam_id, preparation_id)
  REFERENCES "__SCHEMA__".mock_run(id, owner_id, exam_id, preparation_id);
CREATE UNIQUE INDEX item_evidence_mock_item_unique ON "__SCHEMA__".item_evidence(mock_run_id, set_id, version, item_id)
  WHERE mock_run_id IS NOT NULL;

ALTER TABLE "__SCHEMA__".mock_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".mock_run FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".mock_run_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".mock_run_event FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_mock_run ON "__SCHEMA__".mock_run TO "__LEARNER__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
CREATE POLICY owned_mock_run_event ON "__SCHEMA__".mock_run_event TO "__LEARNER__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
CREATE POLICY deletion_mock_run ON "__SCHEMA__".mock_run TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
CREATE POLICY deletion_mock_run_event ON "__SCHEMA__".mock_run_event TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
-- The migration-owned definer is still subject to FORCE RLS. These policies retain owner fencing.
CREATE POLICY finalise_mock_run ON "__SCHEMA__".mock_run TO CURRENT_USER
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
CREATE POLICY finalise_mock_preparation ON "__SCHEMA__".learner_preparation TO CURRENT_USER
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
CREATE POLICY finalise_mock_evidence ON "__SCHEMA__".item_evidence TO CURRENT_USER
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

REVOKE ALL ON "__SCHEMA__".mock_run, "__SCHEMA__".mock_run_event FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".mock_run TO "__LEARNER__";
GRANT INSERT (id, owner_id, preparation_id, exam_id, release_version, blueprint_version, form_id,
  form_version, start_event_id, title, scope, mode) ON "__SCHEMA__".mock_run TO "__LEARNER__";
GRANT UPDATE (responses, position, revision, updated_at) ON "__SCHEMA__".mock_run TO "__LEARNER__";
GRANT SELECT, INSERT ON "__SCHEMA__".mock_run_event TO "__LEARNER__";
GRANT SELECT, DELETE ON "__SCHEMA__".mock_run, "__SCHEMA__".mock_run_event TO "__DELETION__";

CREATE FUNCTION "__SCHEMA__".protect_mock_run() RETURNS trigger
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
  SELECT h.release_version,e.manifest,e.state INTO head_version,head_manifest,head_state
    FROM exam_release_head h JOIN exam_release e ON e.exam_id = h.exam_id AND e.version = h.release_version
    WHERE h.exam_id = NEW.exam_id FOR SHARE OF h;
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
    OR NOT EXISTS (SELECT 1 FROM exam_form_member f WHERE f.exam_id = NEW.exam_id AND f.form_id = NEW.form_id
      AND f.form_version = NEW.form_version AND f.position = (NEW.position->>'member')::integer
      AND (NEW.position->>'item')::integer < f.item_count)
  THEN RAISE EXCEPTION 'invalid_mock_position' USING ERRCODE = '23514'; END IF;
  FOR response_row IN SELECT value FROM jsonb_array_elements(NEW.responses) LOOP
    IF jsonb_typeof(response_row) <> 'object' OR NOT (response_row ?& ARRAY['setId','version','itemId','answer'])
      OR (SELECT count(*) FROM jsonb_object_keys(response_row)) <> 4
    THEN RAISE EXCEPTION 'invalid_mock_response' USING ERRCODE = '23514'; END IF;
    response_tuple := jsonb_build_array(response_row->>'setId', response_row->>'version', response_row->>'itemId')::text;
    IF response_tuple = ANY(tuples) THEN RAISE EXCEPTION 'duplicate_mock_response' USING ERRCODE = '23514'; END IF;
    tuples := array_append(tuples, response_tuple);
    SELECT f.interaction, s.payload INTO member_row FROM exam_form_member f
      JOIN objective_set s ON s.set_id = f.set_id AND s.version = f.set_version AND s.exam_id = f.exam_id
      WHERE f.exam_id = NEW.exam_id AND f.form_id = NEW.form_id AND f.form_version = NEW.form_version
        AND f.set_id = response_row->>'setId' AND f.set_version = response_row->>'version';
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_mock_item' USING ERRCODE = '23514'; END IF;
    item_array := member_row.payload -> CASE member_row.interaction WHEN 'matching_headlines' THEN 'texts'
      WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' ELSE 'gaps' END;
    SELECT value INTO item_row FROM jsonb_array_elements(item_array)
      WHERE coalesce(value->>'id', value->>'n') = response_row->>'itemId';
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_mock_item' USING ERRCODE = '23514'; END IF;
    IF response_row->'answer' <> 'null'::jsonb THEN
      IF jsonb_typeof(response_row->'answer') <> 'string' THEN RAISE EXCEPTION 'invalid_mock_answer' USING ERRCODE = '23514'; END IF;
      IF member_row.interaction IN ('single_choice','gap_choice') THEN
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
CREATE TRIGGER protect_mock_run BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_run
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_run();

CREATE FUNCTION "__SCHEMA__".protect_mock_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = "__SCHEMA__", pg_temp AS $fn$
BEGIN
  IF NEW.mock_run_id IS NOT NULL THEN
    IF current_user = '__LEARNER__' OR NOT EXISTS (
      SELECT 1 FROM mock_run r JOIN exam_form_member f ON f.exam_id = r.exam_id AND f.form_id = r.form_id
        AND f.form_version = r.form_version
      WHERE r.id = NEW.mock_run_id AND r.owner_id = NEW.owner_id AND r.preparation_id = NEW.preparation_id
        AND r.exam_id = NEW.exam_id AND r.state = 'finalised' AND f.set_id = NEW.set_id AND f.set_version = NEW.version)
    THEN RAISE EXCEPTION 'invalid_mock_evidence' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_mock_evidence() FROM PUBLIC;
CREATE TRIGGER protect_mock_evidence BEFORE INSERT ON "__SCHEMA__".item_evidence
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_evidence();

CREATE FUNCTION "__SCHEMA__".finalise_mock_run(p_id uuid, p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  who text := nullif(current_setting('hatoove.owner_id', true), '');
  run_row mock_run%ROWTYPE; prep_id uuid; prep_state text; member_row record;
  item_row jsonb; item_id text; answer jsonb; expected jsonb; explanation jsonb;
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
    FOR item_row IN SELECT value FROM jsonb_array_elements(member_row.payload -> CASE member_row.interaction
      WHEN 'matching_headlines' THEN 'texts' WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' ELSE 'gaps' END) LOOP
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
  IF total_count <> (SELECT sum(item_count) FROM exam_form_member WHERE exam_id = run_row.exam_id
    AND form_id = run_row.form_id AND form_version = run_row.form_version) OR total_count = 0
  THEN RAISE EXCEPTION 'invalid_mock_form' USING ERRCODE = '23514'; END IF;
  saved_result := jsonb_build_object('items',all_items,'answered',answered_count,'unanswered',total_count-answered_count,
    'correct',correct_count,'total',total_count);
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

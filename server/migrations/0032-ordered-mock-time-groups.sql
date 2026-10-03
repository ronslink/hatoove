-- Complete forms get one pinned cumulative schedule; section forms keep their original deadline.
-- The worker validates every pinned public member/media right before and after grading.
-- It receives no objective keys and no content or learner mutation grants here.
GRANT SELECT(exam_id,version,payload) ON "__SCHEMA__".exam_blueprint TO "__WORKER__";
GRANT SELECT(exam_id,form_id,form_version,set_id,set_version,position,interaction)
 ON "__SCHEMA__".exam_form_member TO "__WORKER__";
GRANT SELECT(set_id,version,exam_id,family,section,part,title,payload,item_count,media_required,content_version_id)
 ON "__SCHEMA__".objective_set TO "__WORKER__";
GRANT SELECT ON "__SCHEMA__".exam_media TO "__WORKER__";

CREATE TABLE "__SCHEMA__".mock_run_time_group (
 owner_id text NOT NULL,
 run_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0),
 group_id text NOT NULL,
 sections text[] NOT NULL CHECK(cardinality(sections)>0),
 starts_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL CHECK(deadline_at>starts_at),
 PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,group_id),
 FOREIGN KEY(run_id,owner_id) REFERENCES "__SCHEMA__".mock_run(id,owner_id) ON DELETE CASCADE
);
ALTER TABLE "__SCHEMA__".mock_run_time_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".mock_run_time_group FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_mock_time_group ON "__SCHEMA__".mock_run_time_group TO "__LEARNER__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_mock_time_group ON "__SCHEMA__".mock_run_time_group TO "__DELETION__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY provision_mock_time_group ON "__SCHEMA__".mock_run_time_group TO CURRENT_USER
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))
 WITH CHECK(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
REVOKE ALL ON "__SCHEMA__".mock_run_time_group FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".mock_run_time_group TO "__LEARNER__";
GRANT SELECT,DELETE ON "__SCHEMA__".mock_run_time_group TO "__DELETION__";

CREATE FUNCTION "__SCHEMA__".protect_mock_time_group() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE r mock_run%ROWTYPE; groups jsonb; g jsonb; prior_seconds integer;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'mock_timing_immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id;
 IF r.id IS NULL OR NEW.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'')
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT b.payload->'timeGroups' INTO groups FROM exam_form f JOIN exam_blueprint b ON b.exam_id=f.exam_id AND b.version=f.blueprint_version
  WHERE f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.version=r.form_version
   AND f.payload->>'scope'='complete_supported_written' AND f.payload->>'timingPolicy'='ordered-fixed-v1';
 g:=groups->NEW.ordinal;
 SELECT coalesce(sum((value->>'seconds')::integer),0) INTO prior_seconds
  FROM jsonb_array_elements(groups) WITH ORDINALITY WHERE ordinality<=NEW.ordinal;
 IF g IS NULL OR NEW.group_id IS DISTINCT FROM g->>'id'
  OR NEW.sections IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(g->'sections'))
  OR NEW.starts_at IS DISTINCT FROM r.created_at+make_interval(secs=>prior_seconds)
  OR NEW.deadline_at IS DISTINCT FROM NEW.starts_at+make_interval(secs=>(g->>'seconds')::integer)
 THEN RAISE EXCEPTION 'invalid_mock_timing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_mock_time_group() FROM PUBLIC;
CREATE TRIGGER protect_mock_time_group BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_run_time_group
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_time_group();

CREATE FUNCTION "__SCHEMA__".require_mock_time_group(p_id uuid,p_section text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE r mock_run%ROWTYPE; instant timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO r FROM mock_run WHERE id=p_id AND owner_id=nullif(current_setting('hatoove.owner_id',true),'');
 IF r.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF r.scope<>'complete_supported_written' THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM mock_run_time_group WHERE run_id=r.id AND owner_id=r.owner_id
  AND p_section=ANY(sections) AND instant>=starts_at AND instant<deadline_at)
 THEN RAISE EXCEPTION 'mock_group_inactive' USING ERRCODE='23514'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".require_mock_time_group(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".require_mock_time_group(uuid,text) TO "__LEARNER__";

CREATE FUNCTION "__SCHEMA__".protect_ordered_mock_run() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE form jsonb; blueprint jsonb; seconds integer; changed record; section_id text;
BEGIN
 IF NEW.scope<>'complete_supported_written' THEN RETURN NEW; END IF;
 SELECT f.payload,b.payload INTO form,blueprint FROM exam_form f JOIN exam_blueprint b ON b.exam_id=f.exam_id AND b.version=f.blueprint_version
  WHERE f.exam_id=NEW.exam_id AND f.form_id=NEW.form_id AND f.version=NEW.form_version;
 IF form->>'timingPolicy' IS DISTINCT FROM 'ordered-fixed-v1' OR form->>'attemptMode' IS DISTINCT FROM 'mock'
  OR form->>'mode' IS DISTINCT FROM 'timed' OR jsonb_typeof(blueprint->'timeGroups') IS DISTINCT FROM 'array'
  OR jsonb_array_length(blueprint->'timeGroups')=0
 THEN RAISE EXCEPTION 'invalid_mock_timing' USING ERRCODE='23514'; END IF;
 SELECT sum((value->>'seconds')::integer) INTO seconds FROM jsonb_array_elements(blueprint->'timeGroups');
 IF seconds IS DISTINCT FROM (form->>'timeLimitSeconds')::integer OR seconds<=0
 THEN RAISE EXCEPTION 'invalid_mock_timing' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  NEW.deadline_at:=NEW.created_at+make_interval(secs=>seconds);
 ELSE
  FOR changed IN
   SELECT coalesce(a.value,b.value) AS response FROM jsonb_array_elements(OLD.responses) a FULL JOIN jsonb_array_elements(NEW.responses) b
    ON ROW(a.value->>'setId',a.value->>'version',a.value->>'itemId')=ROW(b.value->>'setId',b.value->>'version',b.value->>'itemId')
    WHERE a.value IS DISTINCT FROM b.value
  LOOP
   SELECT s.section INTO section_id FROM exam_form_member f JOIN objective_set s ON s.set_id=f.set_id AND s.version=f.set_version AND s.exam_id=f.exam_id
    WHERE f.exam_id=NEW.exam_id AND f.form_id=NEW.form_id AND f.form_version=NEW.form_version
     AND f.set_id=changed.response->>'setId' AND f.set_version=changed.response->>'version';
   PERFORM require_mock_time_group(NEW.id,section_id);
  END LOOP;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_ordered_mock_run() FROM PUBLIC;
-- Alphabetical order puts this after the original run validator/deadline assignment.
CREATE TRIGGER timing_mock_run BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_run
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_ordered_mock_run();

CREATE FUNCTION "__SCHEMA__".create_mock_time_groups() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE groups jsonb; g record; instant timestamptz:=NEW.created_at;
BEGIN
 IF NEW.scope<>'complete_supported_written' THEN RETURN NEW; END IF;
 SELECT payload->'timeGroups' INTO groups FROM exam_blueprint WHERE exam_id=NEW.exam_id AND version=NEW.blueprint_version;
 FOR g IN SELECT value,ordinality FROM jsonb_array_elements(groups) WITH ORDINALITY LOOP
  INSERT INTO mock_run_time_group(owner_id,run_id,ordinal,group_id,sections,starts_at,deadline_at)
   VALUES(NEW.owner_id,NEW.id,g.ordinality-1,g.value->>'id',ARRAY(SELECT jsonb_array_elements_text(g.value->'sections')),
    instant,instant+make_interval(secs=>(g.value->>'seconds')::integer));
  instant:=instant+make_interval(secs=>(g.value->>'seconds')::integer);
 END LOOP;
 IF instant IS DISTINCT FROM NEW.deadline_at THEN RAISE EXCEPTION 'invalid_mock_timing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".create_mock_time_groups() FROM PUBLIC;
CREATE TRIGGER create_mock_time_groups AFTER INSERT ON "__SCHEMA__".mock_run
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".create_mock_time_groups();

CREATE FUNCTION "__SCHEMA__".protect_mock_group_mutation() RETURNS trigger
 LANGUAGE plpgsql SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE run_id uuid; section_id text;
BEGIN
 IF TG_TABLE_NAME='drafts' THEN
  SELECT r.id,coalesce(f.payload#>>'{writingTask,section}',g.value->>'section') INTO run_id,section_id
   FROM mock_writing w JOIN mock_run r ON r.id=w.run_id AND r.owner_id=w.owner_id
   JOIN exam_form f ON f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.version=r.form_version
   LEFT JOIN LATERAL jsonb_array_elements(f.payload->'writingChoices') g ON g.value->>'id'=w.choice_group_id
   WHERE w.attempt_id=NEW.attempt_id AND w.owner_id=nullif(current_setting('hatoove.owner_id',true),'');
 ELSIF TG_TABLE_NAME='mock_writing' THEN
  -- Assigned empty drafts attach atomically at start, before their later writing window.
  IF NEW.binding_kind='assigned' THEN RETURN NEW; END IF;
  SELECT r.id,g.value->>'section' INTO run_id,section_id FROM mock_run r
   JOIN exam_form f ON f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.version=r.form_version
   CROSS JOIN LATERAL jsonb_array_elements(f.payload->'writingChoices') g
   WHERE r.id=NEW.run_id AND r.owner_id=NEW.owner_id AND g.value->>'id'=NEW.choice_group_id;
 ELSE
  SELECT r.id,s.section INTO run_id,section_id FROM mock_run r
   JOIN exam_form_member f ON f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.form_version=r.form_version
   JOIN objective_set s ON s.set_id=f.set_id AND s.version=f.set_version AND s.exam_id=f.exam_id
   CROSS JOIN LATERAL jsonb_array_elements(s.payload->'recordings') recording
   WHERE r.id=NEW.run_id AND r.owner_id=NEW.owner_id AND recording.value->>'mediaId'=NEW.media_id AND recording.value->>'mediaVersion'=NEW.media_version;
 END IF;
 IF run_id IS NOT NULL THEN PERFORM require_mock_time_group(run_id,section_id); END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_mock_group_mutation() FROM PUBLIC;
CREATE TRIGGER timing_attached_draft BEFORE UPDATE ON "__SCHEMA__".drafts
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_group_mutation();
CREATE TRIGGER timing_mock_writing BEFORE INSERT ON "__SCHEMA__".mock_writing
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_group_mutation();
CREATE TRIGGER timing_listening_playback BEFORE INSERT OR UPDATE ON "__SCHEMA__".listening_playback
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_mock_group_mutation();

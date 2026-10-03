-- Definer guards remain subject to FORCE RLS. Permit only the bound session owner's
-- identities for guard resolution; no runtime role gains a grant or policy here.
CREATE POLICY review_guard_attempts ON "__SCHEMA__".attempts FOR SELECT TO CURRENT_USER
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY review_guard_submissions ON "__SCHEMA__".submissions FOR SELECT TO CURRENT_USER
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY review_guard_mock_writing ON "__SCHEMA__".mock_writing FOR SELECT TO CURRENT_USER
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));

-- Effective review consumption. Immutable import metadata and previous migrations remain intact.
CREATE VIEW "__SCHEMA__".reviewed_content_version WITH (security_invoker=true) AS
 SELECT c.content_version_id,c.kind,c.family,c.source_path,r.review_status,c.review_status AS raw_review_status,
 c.rights_status,c.content_sha256,c.exam_id,c.created_at,r.review_basis,r.blocked AS review_blocked,
 r.explicit_negative AS review_explicit_negative
 FROM "__SCHEMA__".content_version c CROSS JOIN LATERAL "__SCHEMA__".effective_content_review(c.content_version_id) r;
REVOKE ALL ON "__SCHEMA__".reviewed_content_version FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".reviewed_content_version TO "__LEARNER__","__WORKER__";

-- Private exact-reference predicate shared by publication, admission, and pinned active operations.
-- The SQL backstop accepts unreviewed preview content but never an explicit negative/missing identity.
CREATE FUNCTION "__SCHEMA__".form_review_allowed(p_exam text,p_form text,p_version text,p_approved boolean DEFAULT false)
 RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE form record; review record; member record; identity text; recording jsonb; taskref jsonb; task record;
BEGIN
 SELECT * INTO form FROM exam_form WHERE exam_id=p_exam AND form_id=p_form AND version=p_version;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR review IN SELECT * FROM effective_format_review(p_exam,'form',p_form,p_version)
   UNION ALL SELECT * FROM effective_format_review(p_exam,'blueprint',p_exam,form.blueprint_version) LOOP
  IF review.blocked OR (p_approved AND review.review_status<>'approved') THEN RETURN false; END IF;
 END LOOP;
 FOR member IN SELECT s.*,m.interaction FROM exam_form_member m JOIN objective_set s
  ON s.set_id=m.set_id AND s.version=m.set_version AND s.exam_id=m.exam_id
  WHERE m.exam_id=p_exam AND m.form_id=p_form AND m.form_version=p_version LOOP
  SELECT * INTO review FROM effective_content_review(member.content_version_id);
  IF review.blocked OR (p_approved AND review.review_status<>'approved') THEN RETURN false; END IF;
  IF member.interaction='fixed_audio' THEN
   FOR recording IN SELECT value FROM jsonb_array_elements(member.payload->'recordings') LOOP
    SELECT content_version_id INTO identity FROM exam_media WHERE exam_id=p_exam AND media_id=recording->>'mediaId' AND version=recording->>'mediaVersion';
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO review FROM effective_content_review(identity);
    IF review.blocked OR (p_approved AND review.review_status<>'approved') THEN RETURN false; END IF;
   END LOOP;
  END IF;
 END LOOP;
 FOR taskref IN SELECT o.value FROM jsonb_array_elements(coalesce(form.payload->'writingChoices','[]'::jsonb)) g
  CROSS JOIN LATERAL jsonb_array_elements(g.value->'options') o
  UNION ALL SELECT form.payload->'writingTask' WHERE jsonb_typeof(form.payload->'writingTask')='object' LOOP
  SELECT t.content_version_id,r.content_version_id AS rubric_content INTO task FROM task_version t JOIN rubric_version r
   ON r.rubric_id=t.rubric_id AND r.version=t.rubric_version AND r.exam_id=t.exam_id
   WHERE t.exam_id=p_exam AND t.task_id=taskref->>'taskId' AND t.version=taskref->>'taskVersion';
  IF NOT FOUND THEN RETURN false; END IF;
  FOR review IN SELECT * FROM effective_content_review(task.content_version_id)
   UNION ALL SELECT * FROM effective_content_review(task.rubric_content) LOOP
   IF review.blocked OR (p_approved AND review.review_status<>'approved') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".form_review_allowed(text,text,text,boolean) FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".require_attempt_review(p_owner text,p_attempt uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE binding record; review record; origin record;
BEGIN
 SELECT t.content_version_id,r.content_version_id AS rubric_content,a.exam_id INTO binding FROM attempts a
 JOIN task_version t ON t.task_id=a.task_id AND t.version=a.task_version AND t.exam_id=a.exam_id
 JOIN rubric_version r ON r.rubric_id=a.rubric_id AND r.version=a.rubric_version AND r.exam_id=a.exam_id
 WHERE a.id=p_attempt AND a.owner_id=p_owner;
 IF NOT FOUND THEN RAISE EXCEPTION 'content_unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(binding.exam_id,7351));
 FOR review IN SELECT * FROM effective_content_review(binding.content_version_id) UNION ALL SELECT * FROM effective_content_review(binding.rubric_content) LOOP
  IF review.blocked THEN RAISE EXCEPTION 'review_blocked' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR origin IN WITH RECURSIVE lineage AS (
  SELECT id,parent_submission_id,ARRAY[id] AS visited FROM attempts WHERE id=p_attempt AND owner_id=p_owner
  UNION ALL SELECT parent.id,parent.parent_submission_id,l.visited||parent.id FROM lineage l
   JOIN submissions s ON s.id=l.parent_submission_id AND s.owner_id=p_owner
   JOIN attempts parent ON parent.id=s.attempt_id AND parent.owner_id=p_owner WHERE NOT parent.id=ANY(l.visited)
 ) SELECT r.* FROM lineage l JOIN mock_writing w ON w.attempt_id=l.id AND w.owner_id=p_owner
 JOIN mock_run r ON r.id=w.run_id AND r.owner_id=p_owner LOOP
  IF NOT form_review_allowed(origin.exam_id,origin.form_id,origin.form_version) THEN RAISE EXCEPTION 'review_blocked' USING ERRCODE='23514'; END IF;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".require_attempt_review(text,uuid) FROM PUBLIC;

-- A row UPDATE trigger runs after its target tuple is locked. The statement guard therefore
-- serializes learner writers by validated session owner before tuples; row guards then fence the
-- immutable exam. Reviewer administration takes only exam locks, never learner tuples/owners.
CREATE FUNCTION "__SCHEMA__".review_owner_statement() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text;
BEGIN
 IF current_user='__LEARNER__' THEN
  who:=nullif(current_setting('hatoove.owner_id',true),'');
  IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(who,7352));
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".review_owner_statement() FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".guard_review_use() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text:=nullif(current_setting('hatoove.owner_id',true),''); ex text; run record; review record; identity text;
BEGIN
 -- These triggers guard learner use, not tombstoning/account deletion or worker bookkeeping.
 IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF TG_TABLE_NAME='drafts' THEN
  IF NOT EXISTS(SELECT 1 FROM attempts WHERE id=NEW.attempt_id AND owner_id=who) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 ELSIF NEW.owner_id IS DISTINCT FROM who THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(who,7352));
 IF TG_TABLE_NAME='mock_run' THEN
  ex:=NEW.exam_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(ex,7351));
  IF NOT form_review_allowed(ex,NEW.form_id,NEW.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='mock_writing' THEN
  SELECT * INTO run FROM mock_run WHERE id=NEW.run_id AND owner_id=who;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(run.exam_id,7351));
  IF NOT form_review_allowed(run.exam_id,run.form_id,run.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
  PERFORM require_attempt_review(who,NEW.attempt_id);
 ELSIF TG_TABLE_NAME='item_evidence' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.exam_id,7351));
  SELECT s.content_version_id INTO identity FROM objective_set s WHERE s.exam_id=NEW.exam_id AND s.set_id=NEW.set_id AND s.version=NEW.version;
  SELECT * INTO review FROM effective_content_review(identity);
  IF review.blocked THEN RAISE EXCEPTION 'review_blocked' USING ERRCODE='23514'; END IF;
 ELSE
  PERFORM require_attempt_review(who,NEW.attempt_id);
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_review_use() FROM PUBLIC;
CREATE TRIGGER a_review_owner BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_run FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT OR UPDATE ON "__SCHEMA__".listening_playback FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT OR UPDATE ON "__SCHEMA__".drafts FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT ON "__SCHEMA__".mock_writing FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT ON "__SCHEMA__".submissions FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT ON "__SCHEMA__".item_evidence FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_owner BEFORE INSERT OR UPDATE ON "__SCHEMA__".attempts FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".review_owner_statement();
CREATE TRIGGER a_review_use BEFORE INSERT OR UPDATE ON "__SCHEMA__".mock_run FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_review_use();
CREATE TRIGGER a_review_use BEFORE INSERT OR UPDATE ON "__SCHEMA__".drafts FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_review_use();
CREATE TRIGGER a_review_use BEFORE INSERT ON "__SCHEMA__".mock_writing FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_review_use();
CREATE TRIGGER a_review_use BEFORE INSERT ON "__SCHEMA__".submissions FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_review_use();
CREATE TRIGGER a_review_use BEFORE INSERT ON "__SCHEMA__".item_evidence FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_review_use();

CREATE OR REPLACE FUNCTION "__SCHEMA__".complete_dtz_form_eligible(p_form text,p_version text,p_blueprint text,p_rights text[])
 RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE f jsonb; b jsonb; part jsonb; section jsonb; g jsonb; ref jsonb; rec jsonb; opt jsonb;
 m record; asset record; task record; criterion jsonb; expected jsonb;
 parts jsonb:='[["HV","HV1",4,"fixed_audio"],["HV","HV2",5,"fixed_audio"],["HV","HV3",8,"fixed_audio"],["HV","HV4",3,"fixed_audio"],["LV","LV1",5,"single_choice"],["LV","LV2",5,"matching_ads"],["LV","LV3",6,"grouped_choice"],["LV","LV4",3,"single_choice"],["LV","LV5",6,"gap_choice"],["SA","writing",1,"writing_choice"]]';
 answers jsonb; ids text[]; media_ids text[]:=ARRAY[]::text[]; group_ids text[]:=ARRAY[]::text[];
 item_id text; media_key text; i integer:=0; section_index integer; member_position integer;
BEGIN
 IF NOT form_review_allowed('dtz-a2-b1',p_form,p_version,true) THEN RETURN false; END IF;
 SELECT payload INTO f FROM "__SCHEMA__".exam_form WHERE exam_id='dtz-a2-b1' AND form_id=p_form AND version=p_version AND blueprint_version=p_blueprint;
 SELECT payload INTO b FROM "__SCHEMA__".exam_blueprint WHERE exam_id='dtz-a2-b1' AND version=p_blueprint;
 IF f IS NULL OR b IS NULL OR f->>'id' IS DISTINCT FROM p_form OR f->>'version' IS DISTINCT FROM p_version OR b->>'version' IS DISTINCT FROM p_blueprint
  OR b->'exam'->>'id' IS DISTINCT FROM 'dtz-a2-b1' OR b->'exam'->>'language' IS DISTINCT FROM 'de'
  OR f->>'scope' IS DISTINCT FROM 'complete_supported_written' OR f->>'mode' IS DISTINCT FROM 'timed'
  OR f->>'attemptMode' IS DISTINCT FROM 'mock' OR f->>'timingPolicy' IS DISTINCT FROM 'ordered-fixed-v1'
  OR f->'sections' IS DISTINCT FROM '["HV","LV","SA"]'::jsonb OR f->'timeLimitSeconds' IS DISTINCT FROM '6000'::jsonb
  OR f->>'feedback' IS DISTINCT FROM 'finalise' OR f ? 'writingTask'
  OR jsonb_array_length(f->'members')<>9 OR jsonb_array_length(b->'sections')<>3 OR jsonb_array_length(b->'timeGroups')<>3
  OR jsonb_array_length(f->'writingChoices')<>1 THEN RETURN false; END IF;
 FOR section_index IN 0..2 LOOP
  section:=b->'sections'->section_index;g:=b->'timeGroups'->section_index;
  IF section->>'id' IS DISTINCT FROM (ARRAY['HV','LV','SA'])[section_index+1]
   OR g->'sections' IS DISTINCT FROM jsonb_build_array(section->>'id')
   OR g->'seconds' IS DISTINCT FROM to_jsonb((ARRAY[1500,2700,1800])[section_index+1])
   OR jsonb_typeof(g->'id') IS DISTINCT FROM 'string' OR length(g->>'id') NOT BETWEEN 1 AND 128
   OR "__SCHEMA__".s6_payload_identity(g->'id',128) IS NULL
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(g) key WHERE key<>ALL(ARRAY['id','seconds','sections']))
   OR g->>'id'=ANY(group_ids) OR section->>'timeGroup' IS DISTINCT FROM g->>'id'
   OR jsonb_typeof(section->'parts') IS DISTINCT FROM 'array' OR jsonb_array_length(section->'parts')<>(ARRAY[4,5,1])[section_index+1] THEN RETURN false; END IF;
  group_ids:=array_append(group_ids,g->>'id');
  FOR part IN SELECT value FROM jsonb_array_elements(section->'parts') LOOP
   expected:=parts->i;i:=i+1;
   IF jsonb_build_array(section->>'id',part->>'family',part->'itemCount',part->>'interaction') IS DISTINCT FROM expected
    OR part->'mediaRequired' IS DISTINCT FROM to_jsonb(part->>'interaction'='fixed_audio') THEN RETURN false; END IF;
   IF part->>'interaction'='fixed_audio' AND part->'playback' IS DISTINCT FROM '{"practice":1,"mock":1}'::jsonb THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 IF i<>10 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM "__SCHEMA__".exam_form_member WHERE exam_id='dtz-a2-b1' AND form_id=p_form AND form_version=p_version)<>9 THEN RETURN false; END IF;
 FOR member_position IN 0..8 LOOP
  ref:=f->'members'->member_position;expected:=parts->member_position;
  SELECT s.*,fm.interaction,fm.item_count AS bound_count,c.review_status,c.exam_id AS content_exam,coalesce(cr.basis,c.rights_status) AS rights
   INTO m FROM "__SCHEMA__".exam_form_member fm JOIN "__SCHEMA__".objective_set s ON s.set_id=fm.set_id AND s.version=fm.set_version AND s.exam_id=fm.exam_id
   JOIN "__SCHEMA__".reviewed_content_version c USING(content_version_id) LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
   WHERE fm.exam_id='dtz-a2-b1' AND fm.form_id=p_form AND fm.form_version=p_version AND fm.position=member_position;
  IF NOT FOUND OR m.set_id IS DISTINCT FROM ref->>'setId' OR m.version IS DISTINCT FROM ref->>'version'
   OR m.section IS DISTINCT FROM expected->>0 OR m.family IS DISTINCT FROM expected->>1 OR m.item_count IS DISTINCT FROM (expected->>2)::integer
   OR m.bound_count IS DISTINCT FROM m.item_count OR ref->'itemCount' IS DISTINCT FROM to_jsonb(m.item_count)
   OR m.interaction IS DISTINCT FROM expected->>3 OR ref->>'interaction' IS DISTINCT FROM m.interaction
   OR m.part IS DISTINCT FROM (CASE WHEN member_position<4 THEN member_position+1 ELSE member_position-3 END)
   OR m.media_required IS DISTINCT FROM (member_position<4) OR m.content_exam IS DISTINCT FROM 'dtz-a2-b1'
   OR m.review_status IS DISTINCT FROM 'approved' OR NOT coalesce(m.rights=ANY(p_rights),false) THEN RETURN false; END IF;
  SELECT k.answers INTO answers FROM "__SCHEMA__".objective_key k WHERE k.set_id=m.set_id AND k.version=m.version;
  IF NOT FOUND OR NOT "__SCHEMA__".complete_dtz_objective_eligible(m.payload,m.interaction,m.item_count,answers) THEN RETURN false; END IF;
  IF m.interaction='fixed_audio' THEN
   FOR rec IN SELECT value FROM jsonb_array_elements(m.payload->'recordings') LOOP
    media_key:=(rec->>'mediaId')||'@'||(rec->>'mediaVersion');
    IF media_key=ANY(media_ids) THEN RETURN false; END IF;
    media_ids:=array_append(media_ids,media_key);
    SELECT a.*,c.review_status,c.content_sha256,coalesce(cr.basis,c.rights_status) AS rights INTO asset
     FROM "__SCHEMA__".exam_media a JOIN "__SCHEMA__".reviewed_content_version c USING(content_version_id)
     LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
     WHERE a.media_id=rec->>'mediaId' AND a.version=rec->>'mediaVersion' AND a.exam_id='dtz-a2-b1' AND c.exam_id=a.exam_id;
    IF NOT FOUND OR asset.review_status IS DISTINCT FROM 'approved' OR NOT coalesce(asset.rights=ANY(p_rights),false) THEN RETURN false; END IF;
   END LOOP;
  END IF;
 END LOOP;
 g:=f->'writingChoices'->0;
 IF jsonb_typeof(g->'id') IS DISTINCT FROM 'string' OR length(btrim(g->>'id'))=0 OR g->>'section' IS DISTINCT FROM 'SA'
  OR jsonb_array_length(g->'options')<>2 OR g->'options'->0->>'id' IS DISTINCT FROM 'A' OR g->'options'->1->>'id' IS DISTINCT FROM 'B'
  OR (g->'options'->0->>'taskId',g->'options'->0->>'taskVersion') IS NOT DISTINCT FROM (g->'options'->1->>'taskId',g->'options'->1->>'taskVersion') THEN RETURN false; END IF;
 FOR opt IN SELECT value FROM jsonb_array_elements(g->'options') LOOP
  SELECT t.*,c.review_status,c.exam_id AS content_exam,coalesce(cr.basis,c.rights_status) AS rights,
   r.policy,r.feedback_kind,r.criteria,r.max_total,rc.review_status AS rubric_review,rc.exam_id AS rubric_exam,coalesce(rr.basis,rc.rights_status) AS rubric_rights
   INTO task FROM "__SCHEMA__".task_version t JOIN "__SCHEMA__".reviewed_content_version c USING(content_version_id)
   LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
   JOIN "__SCHEMA__".rubric_version r ON r.rubric_id=t.rubric_id AND r.version=t.rubric_version AND r.exam_id=t.exam_id
   JOIN "__SCHEMA__".reviewed_content_version rc ON rc.content_version_id=r.content_version_id LEFT JOIN "__SCHEMA__".content_rights rr ON rr.content_version_id=rc.content_version_id
   WHERE t.task_id=opt->>'taskId' AND t.version=opt->>'taskVersion' AND t.exam_id='dtz-a2-b1';
  IF NOT FOUND OR task.content_exam IS DISTINCT FROM 'dtz-a2-b1' OR task.rubric_exam IS DISTINCT FROM 'dtz-a2-b1'
   OR task.family IS DISTINCT FROM 'writing' OR task.section IS DISTINCT FROM 'SA' OR task.review_status IS DISTINCT FROM 'approved'
   OR task.rubric_review IS DISTINCT FROM 'approved' OR NOT coalesce(task.rights=ANY(p_rights),false) OR NOT coalesce(task.rubric_rights=ANY(p_rights),false)
   OR task.policy IS DISTINCT FROM 'dtz-writing-practice-v1' OR task.feedback_kind IS DISTINCT FROM 'dtz-writing-bands'
   OR task.max_total IS NOT NULL OR jsonb_array_length(task.criteria)<>4 OR jsonb_array_length(task.leitpunkte)<>4
   OR length(btrim(task.topic))=0 OR length(btrim(task.situation))=0 THEN RETURN false; END IF;
  SELECT array_agg(value->>'key' ORDER BY value->>'key') INTO ids FROM jsonb_array_elements(task.criteria);
  IF ids IS DISTINCT FROM ARRAY['dtz_aufgabe','dtz_kommunikation','dtz_korrektheit','dtz_wortschatz']::text[] THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(task.leitpunkte) point WHERE jsonb_typeof(point)<>'string' OR length(btrim(point#>>'{}'))=0) THEN RETURN false; END IF;
  FOR criterion IN SELECT value FROM jsonb_array_elements(task.criteria) LOOP
   IF criterion->'bands' IS DISTINCT FROM '{"B1_PLUS":5,"B1":4,"A2_PLUS":3,"A2":2,"A1":1,"ZERO":0}'::jsonb
    OR jsonb_typeof(criterion->'label') IS DISTINCT FROM 'string' OR length(btrim(criterion->>'label'))=0 THEN RETURN false; END IF;
   FOR item_id IN SELECT unnest(ARRAY['bandLabels','descriptors']) LOOP
    IF jsonb_typeof(criterion->item_id) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(criterion->item_id))<>6
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(criterion->'bands') band WHERE jsonb_typeof(criterion->item_id->band) IS DISTINCT FROM 'string' OR length(btrim(criterion->item_id->>band))=0) THEN RETURN false; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN data_exception OR null_value_not_allowed THEN RETURN false;
END $fn$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".guard_dtz_attempt_at_commit() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE admitted boolean; ancestor record; parent_id uuid; visited uuid[]:=ARRAY[NEW.id];
BEGIN
 IF NEW.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id,7352));
 PERFORM require_attempt_review(NEW.owner_id,NEW.id);
 IF NEW.exam_id IS DISTINCT FROM 'dtz-a2-b1' THEN RETURN NULL; END IF;
 IF NEW.parent_submission_id IS NOT NULL THEN
  parent_id:=NEW.parent_submission_id;
  WHILE parent_id IS NOT NULL LOOP
   SELECT a.* INTO ancestor FROM "__SCHEMA__".submissions s JOIN "__SCHEMA__".attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id
    WHERE s.id=parent_id AND s.owner_id=NEW.owner_id AND a.exam_id=NEW.exam_id AND a.preparation_id=NEW.preparation_id
     AND a.task_id=NEW.task_id AND a.task_version=NEW.task_version AND a.rubric_id=NEW.rubric_id AND a.rubric_version=NEW.rubric_version
     AND s.task_version=NEW.task_version AND s.rubric_version=NEW.rubric_version AND a.deleted_at IS NULL;
   IF NOT FOUND OR ancestor.id=ANY(visited) THEN RAISE EXCEPTION 'invalid_attempt_continuation' USING ERRCODE='23514'; END IF;
   visited:=array_append(visited,ancestor.id);parent_id:=ancestor.parent_submission_id;
  END LOOP;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM "__SCHEMA__".mock_writing w JOIN "__SCHEMA__".mock_run r ON r.id=w.run_id AND r.owner_id=w.owner_id
  JOIN "__SCHEMA__".exam_form f ON f.exam_id=r.exam_id AND f.form_id=r.form_id AND f.version=r.form_version
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(f.payload->'writingChoices','[]'::jsonb)) g
  CROSS JOIN LATERAL jsonb_array_elements(g->'options') o
  WHERE w.attempt_id=NEW.id AND w.owner_id=NEW.owner_id AND r.exam_id=NEW.exam_id AND r.preparation_id=NEW.preparation_id
   AND w.binding_kind='choice' AND g->>'id'=w.choice_group_id AND o->>'id'=w.selected_option_id
   AND o->>'taskId'=NEW.task_id AND o->>'taskVersion'=NEW.task_version
   AND EXISTS(SELECT 1 FROM "__SCHEMA__".task_version t WHERE t.task_id=NEW.task_id AND t.version=NEW.task_version AND t.exam_id=NEW.exam_id AND t.rubric_id=NEW.rubric_id AND t.rubric_version=NEW.rubric_version)) THEN RETURN NULL; END IF;
 SELECT e.eligible INTO admitted FROM "__SCHEMA__".current_release_eligibility(NEW.exam_id,ARRAY['generated','licensed','commissioned']) e;
 IF NOT coalesce(admitted,false) THEN RAISE EXCEPTION 'task_not_servable' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".mark_objective_item(p_set_id text,p_version text,p_item_id text,p_answer jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE bound_exam text; bound_owner text; admitted boolean; expected jsonb;
BEGIN
 bound_owner:=nullif(current_setting('hatoove.owner_id',true),'');
 IF bound_owner IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(bound_owner,7352));
 SELECT exam_id INTO bound_exam FROM objective_set WHERE set_id=p_set_id AND version=p_version;
 IF bound_exam IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(bound_exam,7351)); END IF;
 IF NOT EXISTS(SELECT 1 FROM objective_set s CROSS JOIN LATERAL effective_content_review(s.content_version_id) r WHERE s.set_id=p_set_id AND s.version=p_version AND NOT r.blocked) THEN RAISE EXCEPTION 'review_blocked' USING ERRCODE='23514'; END IF;
 SELECT s.exam_id INTO bound_exam FROM "__SCHEMA__".objective_set s WHERE s.set_id=p_set_id AND s.version=p_version;
 IF bound_exam='dtz-a2-b1' THEN
  bound_owner:=nullif(current_setting('hatoove.owner_id',true),'');
  IF bound_owner IS NULL THEN RAISE EXCEPTION 'exam_unavailable' USING ERRCODE='23514'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(bound_owner,7352));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(bound_exam,7351));
  SELECT e.eligible INTO admitted FROM "__SCHEMA__".current_release_eligibility(bound_exam,ARRAY['generated','licensed','commissioned']) e;
  IF NOT coalesce(admitted,false) THEN RAISE EXCEPTION 'exam_unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT k.answers->p_item_id INTO expected FROM "__SCHEMA__".objective_key k WHERE k.set_id=p_set_id AND k.version=p_version;
 IF expected IS NULL THEN RAISE EXCEPTION 'unknown_item' USING ERRCODE='P0002'; END IF;
 RETURN expected=p_answer;
END $fn$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".finalise_mock_run(p_id uuid, p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,"__SCHEMA__" AS $fn$
DECLARE
  who text := nullif(current_setting('hatoove.owner_id', true), '');
  run_row mock_run%ROWTYPE; prep_id uuid; bound_exam text; prep_state text; member_row record;
  item_row jsonb; item_array jsonb; item_id text; answer jsonb; expected jsonb; explanation jsonb;
  all_items jsonb := '[]'; saved_result jsonb; marked boolean;
  answered_count integer := 0; correct_count integer := 0; total_count integer := 0;
BEGIN
  IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  -- Same lock order as the adapter and deletion: owner gate, preparation, then run.
  PERFORM pg_advisory_xact_lock(hashtextextended(who, 7352));
  SELECT preparation_id,exam_id INTO prep_id,bound_exam FROM mock_run WHERE id = p_id AND owner_id = who;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(bound_exam,7351));
  SELECT * INTO run_row FROM mock_run WHERE id=p_id AND owner_id=who;
  IF run_row.state<>'finalised' AND NOT form_review_allowed(run_row.exam_id,run_row.form_id,run_row.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
  SELECT state INTO prep_state FROM learner_preparation WHERE id = prep_id AND owner_id = who FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO run_row FROM mock_run WHERE id = p_id AND owner_id = who FOR UPDATE;
  IF EXISTS (SELECT 1 FROM exam_release_head h JOIN exam_release e ON e.exam_id = h.exam_id AND e.version = h.release_version
    WHERE h.exam_id = run_row.exam_id AND coalesce(e.manifest #> '{release,resumeBlockedReleases}', '[]'::jsonb) ? run_row.release_version)
  THEN RAISE EXCEPTION 'mock_rights_blocked' USING ERRCODE = 'P0001'; END IF;
  IF run_row.state = 'finalised' THEN RETURN run_row.result; END IF;
  IF NOT form_review_allowed(run_row.exam_id,run_row.form_id,run_row.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
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
    AND form_id = run_row.form_id AND form_version = run_row.form_version) OR (total_count = 0 AND NOT EXISTS (SELECT 1 FROM exam_form WHERE exam_id=run_row.exam_id AND form_id=run_row.form_id AND version=run_row.form_version AND (jsonb_array_length(coalesce(payload->'writingChoices','[]'::jsonb))=1 OR jsonb_typeof(payload->'writingTask')='object')))
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

CREATE OR REPLACE FUNCTION "__SCHEMA__".protect_listening_playback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE
  r mock_run%ROWTYPE; prep_id uuid; bound_exam text; prep_state text; head_version text; head_manifest jsonb;
  pinned record; policy_count integer; instant timestamptz;
BEGIN
  IF NEW.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'')
  THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id,7352));
  SELECT preparation_id,exam_id INTO prep_id,bound_exam FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(bound_exam,7351));
  SELECT * INTO r FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id;
  IF NOT form_review_allowed(r.exam_id,r.form_id,r.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
  SELECT state INTO prep_state FROM learner_preparation WHERE id=prep_id AND owner_id=NEW.owner_id FOR SHARE;
  IF prep_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'preparation_archived' USING ERRCODE='23514'; END IF;
  SELECT * INTO r FROM mock_run WHERE id=NEW.run_id AND owner_id=NEW.owner_id FOR UPDATE;
  IF NOT form_review_allowed(r.exam_id,r.form_id,r.form_version) THEN RAISE EXCEPTION 'mock_content_unavailable' USING ERRCODE='23514'; END IF;
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
    JOIN reviewed_content_version c ON c.content_version_id=m.content_version_id
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

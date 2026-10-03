-- DTZ public admission is one complete, approved current package. History is not rewritten.
-- This private predicate returns no task, key or media payload. Malformed optional forms fail individually.
CREATE FUNCTION "__SCHEMA__".complete_dtz_form_eligible(p_form text,p_version text,p_blueprint text,p_rights text[])
 RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE f jsonb; b jsonb; part jsonb; section jsonb; g jsonb; ref jsonb; rec jsonb; question jsonb; opt jsonb;
 m record; asset record; task record; criterion jsonb; expected jsonb;
 parts jsonb:='[["HV","HV1",4,"fixed_audio"],["HV","HV2",5,"fixed_audio"],["HV","HV3",8,"fixed_audio"],["HV","HV4",3,"fixed_audio"],["LV","LV1",5,"single_choice"],["LV","LV2",5,"matching_ads"],["LV","LV3",6,"grouped_choice"],["LV","LV4",3,"single_choice"],["LV","LV5",6,"gap_choice"],["SA","writing",1,"writing_choice"]]';
 rows jsonb; answers jsonb; ids text[]; choices text[]; media_ids text[]:=ARRAY[]::text[]; group_ids text[]:=ARRAY[]::text[];
 item_id text; media_key text; i integer:=0; section_index integer; member_position integer;
BEGIN
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
   JOIN "__SCHEMA__".content_version c USING(content_version_id) LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
   WHERE fm.exam_id='dtz-a2-b1' AND fm.form_id=p_form AND fm.form_version=p_version AND fm.position=member_position;
  IF NOT FOUND OR m.set_id IS DISTINCT FROM ref->>'setId' OR m.version IS DISTINCT FROM ref->>'version'
   OR m.section IS DISTINCT FROM expected->>0 OR m.family IS DISTINCT FROM expected->>1 OR m.item_count IS DISTINCT FROM (expected->>2)::integer
   OR m.bound_count IS DISTINCT FROM m.item_count OR ref->'itemCount' IS DISTINCT FROM to_jsonb(m.item_count)
   OR m.interaction IS DISTINCT FROM expected->>3 OR ref->>'interaction' IS DISTINCT FROM m.interaction
   OR m.part IS DISTINCT FROM (CASE WHEN member_position<4 THEN member_position+1 ELSE member_position-3 END)
   OR m.media_required IS DISTINCT FROM (member_position<4) OR m.content_exam IS DISTINCT FROM 'dtz-a2-b1'
   OR m.review_status IS DISTINCT FROM 'approved' OR NOT coalesce(m.rights=ANY(p_rights),false) THEN RETURN false; END IF;
  rows:='[]';choices:=NULL;ids:=ARRAY[]::text[];
  IF m.interaction='fixed_audio' THEN
   IF jsonb_array_length(m.payload->'recordings')<1 THEN RETURN false; END IF;
   group_ids:=ARRAY[]::text[];
   FOR rec IN SELECT value FROM jsonb_array_elements(m.payload->'recordings') LOOP
    media_key:=(rec->>'mediaId')||'@'||(rec->>'mediaVersion');
    IF jsonb_typeof(rec->'id') IS DISTINCT FROM 'string' OR length(btrim(rec->>'id'))=0 OR rec->>'id'=ANY(group_ids)
     OR jsonb_typeof(rec->'label') IS DISTINCT FROM 'string' OR length(btrim(rec->>'label'))=0
     OR media_key IS NULL OR media_key=ANY(media_ids) OR jsonb_array_length(rec->'questions')<1 THEN RETURN false; END IF;
    group_ids:=array_append(group_ids,rec->>'id');media_ids:=array_append(media_ids,media_key);
    SELECT a.*,c.review_status,c.content_sha256,coalesce(cr.basis,c.rights_status) AS rights INTO asset
     FROM "__SCHEMA__".exam_media a JOIN "__SCHEMA__".content_version c USING(content_version_id)
     LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
     WHERE a.media_id=rec->>'mediaId' AND a.version=rec->>'mediaVersion' AND a.exam_id='dtz-a2-b1' AND c.exam_id=a.exam_id;
    IF NOT FOUND OR asset.review_status IS DISTINCT FROM 'approved' OR NOT coalesce(asset.rights=ANY(p_rights),false) THEN RETURN false; END IF;
    rows:=rows||(rec->'questions');
   END LOOP;
  ELSIF m.interaction='grouped_choice' THEN
   IF jsonb_array_length(m.payload->'groups')<1 THEN RETURN false; END IF;
   group_ids:=ARRAY[]::text[];
   FOR g IN SELECT value FROM jsonb_array_elements(m.payload->'groups') LOOP
    IF coalesce(g->>'id','')='' OR g->>'id'=ANY(group_ids) OR jsonb_typeof(g->'text') IS DISTINCT FROM 'string'
     OR length(btrim(g->>'text'))=0 OR jsonb_array_length(g->'questions')<1 THEN RETURN false; END IF;
    group_ids:=array_append(group_ids,g->>'id');rows:=rows||(g->'questions');
   END LOOP;
  ELSIF m.interaction='single_choice' THEN
   IF jsonb_typeof(m.payload->'text') IS DISTINCT FROM 'string' OR length(btrim(m.payload->>'text'))=0 THEN RETURN false; END IF;
   rows:=m.payload->'questions';
  ELSIF m.interaction='matching_ads' THEN
   IF jsonb_typeof(m.payload->'ads') IS DISTINCT FROM 'array' OR jsonb_array_length(m.payload->'ads')<2 THEN RETURN false; END IF;
   choices:=ARRAY['x']::text[];
   FOR opt IN SELECT value FROM jsonb_array_elements(m.payload->'ads') LOOP
    IF coalesce(opt->>'id','')='' OR opt->>'id'=ANY(choices) OR jsonb_typeof(opt->'text') IS DISTINCT FROM 'string' OR length(btrim(opt->>'text'))=0 THEN RETURN false; END IF;
    choices:=array_append(choices,opt->>'id');
   END LOOP;
   rows:=m.payload->'situations';
  ELSIF m.interaction='gap_choice' THEN
   IF jsonb_typeof(m.payload->'letter') IS DISTINCT FROM 'string' OR length(btrim(m.payload->>'letter'))=0 THEN RETURN false; END IF;
   rows:=m.payload->'gaps';
  ELSE RETURN false; END IF;
  IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)<>m.item_count THEN RETURN false; END IF;
  SELECT k.answers INTO answers FROM "__SCHEMA__".objective_key k WHERE k.set_id=m.set_id AND k.version=m.version;
  IF NOT FOUND OR jsonb_typeof(answers) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(answers))<>m.item_count THEN RETURN false; END IF;
  FOR question IN SELECT value FROM jsonb_array_elements(rows) LOOP
   item_id:=question->>'n';
   IF jsonb_typeof(question->'n') NOT IN ('string','number') OR item_id IS NULL OR item_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$' OR item_id=ANY(ids) THEN RETURN false; END IF;
   ids:=array_append(ids,item_id);
   IF m.interaction='matching_ads' THEN
    IF jsonb_typeof(question->'text') IS DISTINCT FROM 'string' OR length(btrim(question->>'text'))=0 THEN RETURN false; END IF;
   ELSE
    IF m.interaction<>'gap_choice' AND (jsonb_typeof(question->'question') IS DISTINCT FROM 'string' OR length(btrim(question->>'question'))=0) THEN RETURN false; END IF;
    IF jsonb_typeof(question->'options') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(question->'options'))<2 THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each(question->'options') e WHERE length(e.key)=0 OR jsonb_typeof(e.value)<>'string' OR length(btrim(e.value#>>'{}'))=0) THEN RETURN false; END IF;
    SELECT array_agg(key) INTO choices FROM jsonb_object_keys(question->'options') key;
   END IF;
   IF jsonb_typeof(answers->item_id) IS DISTINCT FROM 'string' OR NOT coalesce(answers->>item_id=ANY(choices),false) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 g:=f->'writingChoices'->0;
 IF jsonb_typeof(g->'id') IS DISTINCT FROM 'string' OR length(btrim(g->>'id'))=0 OR g->>'section' IS DISTINCT FROM 'SA'
  OR jsonb_array_length(g->'options')<>2 OR g->'options'->0->>'id' IS DISTINCT FROM 'A' OR g->'options'->1->>'id' IS DISTINCT FROM 'B'
  OR (g->'options'->0->>'taskId',g->'options'->0->>'taskVersion') IS NOT DISTINCT FROM (g->'options'->1->>'taskId',g->'options'->1->>'taskVersion') THEN RETURN false; END IF;
 FOR opt IN SELECT value FROM jsonb_array_elements(g->'options') LOOP
  SELECT t.*,c.review_status,c.exam_id AS content_exam,coalesce(cr.basis,c.rights_status) AS rights,
   r.policy,r.feedback_kind,r.criteria,r.max_total,rc.review_status AS rubric_review,rc.exam_id AS rubric_exam,coalesce(rr.basis,rc.rights_status) AS rubric_rights
   INTO task FROM "__SCHEMA__".task_version t JOIN "__SCHEMA__".content_version c USING(content_version_id)
   LEFT JOIN "__SCHEMA__".content_rights cr USING(content_version_id)
   JOIN "__SCHEMA__".rubric_version r ON r.rubric_id=t.rubric_id AND r.version=t.rubric_version AND r.exam_id=t.exam_id
   JOIN "__SCHEMA__".content_version rc ON rc.content_version_id=r.content_version_id LEFT JOIN "__SCHEMA__".content_rights rr ON rr.content_version_id=rc.content_version_id
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
REVOKE ALL ON FUNCTION "__SCHEMA__".complete_dtz_form_eligible(text,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".current_release_eligibility(p_exam_id text,p_allowed_rights text[])
 RETURNS TABLE(eligible boolean,exam_id text,release_version text,state text,reason text,complete_form_id text,complete_form_version text)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE head record; candidate record; rights text[];
BEGIN
 eligible:=false;exam_id:=p_exam_id;reason:='exam_unavailable';
 SELECT array_agg(DISTINCT value) INTO rights FROM unnest(p_allowed_rights) value WHERE value IN ('generated','licensed','commissioned');
 IF coalesce(cardinality(rights),0)=0 THEN reason:='invalid_rights';RETURN NEXT;RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM "__SCHEMA__".exam_package e WHERE e.exam_id=p_exam_id) THEN RETURN NEXT;RETURN; END IF;
 SELECT r.* INTO head FROM "__SCHEMA__".exam_release_head h JOIN "__SCHEMA__".exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version WHERE h.exam_id=p_exam_id;
 release_version:=head.version;state:=head.state;
 IF p_exam_id<>'dtz-a2-b1' THEN eligible:=true;reason:='existing_exam';RETURN NEXT;RETURN; END IF;
 reason:='release_unavailable';
 IF head.version IS NULL OR head.state NOT IN ('internal','available')
  OR head.manifest->'exam'->>'id' IS DISTINCT FROM p_exam_id OR head.manifest->'release'->>'version' IS DISTINCT FROM head.version
  OR head.manifest->'release'->>'state' IS DISTINCT FROM head.state
  OR jsonb_typeof(head.manifest->'release'->'resumeBlockedReleases') IS DISTINCT FROM 'array'
  OR (head.manifest->'release'->'resumeBlockedReleases') ? head.version THEN RETURN NEXT;RETURN; END IF;
 IF head.state='internal' THEN eligible:=true;reason:='internal_preview';RETURN NEXT;RETURN; END IF;
 reason:='complete_form_unavailable';
 FOR candidate IN SELECT rf.form_id,rf.form_version FROM "__SCHEMA__".exam_release_form rf WHERE rf.exam_id=p_exam_id AND rf.release_version=head.version ORDER BY rf.form_id,rf.form_version LOOP
  IF "__SCHEMA__".complete_dtz_form_eligible(candidate.form_id,candidate.form_version,head.blueprint_version,rights) THEN
   eligible:=true;reason:='eligible';complete_form_id:=candidate.form_id;complete_form_version:=candidate.form_version;EXIT;
  END IF;
 END LOOP;
 RETURN NEXT;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".current_release_eligibility(text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".current_release_eligibility(text,text[]) TO "__LEARNER__","__PAYMENTS__";

-- Lexically first BEFORE triggers take owner then exam before existing row/pointer guards.
-- Attempts defer the decision, not the lock: A/B binding is inserted later in the same transaction.
CREATE FUNCTION "__SCHEMA__".guard_new_dtz_admission() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE admitted boolean;
BEGIN
 IF NEW.exam_id IS DISTINCT FROM 'dtz-a2-b1' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='item_evidence' THEN IF NEW.mock_run_id IS NOT NULL THEN RETURN NEW; END IF; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.owner_id,7352));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.exam_id,7351));
 IF TG_TABLE_NAME='attempts' THEN RETURN NEW; END IF;
 SELECT e.eligible INTO admitted FROM "__SCHEMA__".current_release_eligibility(NEW.exam_id,ARRAY['generated','licensed','commissioned']) e;
 IF NOT coalesce(admitted,false) THEN RAISE EXCEPTION 'exam_unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_new_dtz_admission() FROM PUBLIC;
CREATE TRIGGER a_s6_new_admission BEFORE INSERT ON "__SCHEMA__".learner_preparation FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_new_dtz_admission();
CREATE TRIGGER a_s6_new_admission BEFORE INSERT ON "__SCHEMA__".mock_run FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_new_dtz_admission();
CREATE TRIGGER a_s6_new_admission BEFORE INSERT ON "__SCHEMA__".attempts FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_new_dtz_admission();
CREATE TRIGGER a_s6_new_admission BEFORE INSERT ON "__SCHEMA__".item_evidence FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_new_dtz_admission();

CREATE FUNCTION "__SCHEMA__".guard_dtz_attempt_at_commit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE admitted boolean; ancestor record; parent_id uuid; visited uuid[]:=ARRAY[NEW.id];
BEGIN
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
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_dtz_attempt_at_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER s6_attempt_admission AFTER INSERT ON "__SCHEMA__".attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_dtz_attempt_at_commit();

-- Pinned finalisation reads keys internally; this learner-callable function is standalone marking.
CREATE OR REPLACE FUNCTION "__SCHEMA__".mark_objective_item(p_set_id text,p_version text,p_item_id text,p_answer jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE bound_exam text; bound_owner text; admitted boolean; expected jsonb;
BEGIN
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
REVOKE ALL ON FUNCTION "__SCHEMA__".mark_objective_item(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".mark_objective_item(text,text,text,jsonb) TO "__LEARNER__";

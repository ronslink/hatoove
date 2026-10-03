-- Saved prose is separate from immutable assessment/result facts. No existing rows are changed.
ALTER TABLE "__SCHEMA__".assessments ADD CONSTRAINT assessments_owner_identity UNIQUE(submission_id,owner_id);

CREATE TABLE "__SCHEMA__".objective_explanation_representation(
 exam_id text NOT NULL,set_id text NOT NULL,set_version text NOT NULL,item_id text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),
 language text NOT NULL CHECK(language IN ('de','en','uk','ar','tr')),
 representation_version text NOT NULL CHECK(representation_version COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 original_language text CHECK(original_language IN ('de','en','uk','ar','tr')),original_format text NOT NULL CHECK(original_format='objective-string'),
 payload jsonb NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(set_id,set_version,item_id,source_sha256,language,representation_version),
 FOREIGN KEY(set_id,set_version,exam_id) REFERENCES "__SCHEMA__".objective_set(set_id,version,exam_id)
);
CREATE TABLE "__SCHEMA__".objective_explanation_head(
 set_id text NOT NULL,set_version text NOT NULL,item_id text NOT NULL,source_sha256 text NOT NULL,language text NOT NULL,representation_version text NOT NULL,
 PRIMARY KEY(set_id,set_version,item_id,source_sha256,language),
 FOREIGN KEY(set_id,set_version,item_id,source_sha256,language,representation_version)
  REFERENCES "__SCHEMA__".objective_explanation_representation(set_id,set_version,item_id,source_sha256,language,representation_version)
);
CREATE TABLE "__SCHEMA__".writing_explanation_representation(
 owner_id text NOT NULL,submission_id uuid NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),
 language text NOT NULL CHECK(language IN ('de','en','uk','ar','tr')),
 representation_version text NOT NULL CHECK(representation_version COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 attempt_id uuid NOT NULL,exam_id text NOT NULL,task_id text NOT NULL,task_version text NOT NULL,rubric_id text NOT NULL,rubric_version text NOT NULL,
 model_version text NOT NULL,prompt_version text NOT NULL,original_language text NOT NULL CHECK(original_language IN ('de','en','uk','ar','tr')),
 original_format text NOT NULL CHECK(original_format IN ('legacy-comment','telc-b1-bands','dtz-writing-bands')),
 payload jsonb NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,submission_id,source_sha256,language,representation_version),
 FOREIGN KEY(submission_id,owner_id) REFERENCES "__SCHEMA__".assessments(submission_id,owner_id)
);
CREATE TABLE "__SCHEMA__".writing_explanation_head(
 owner_id text NOT NULL,submission_id uuid NOT NULL,source_sha256 text NOT NULL,language text NOT NULL,representation_version text NOT NULL,
 PRIMARY KEY(owner_id,submission_id,source_sha256,language),
 FOREIGN KEY(owner_id,submission_id,source_sha256,language,representation_version)
  REFERENCES "__SCHEMA__".writing_explanation_representation(owner_id,submission_id,source_sha256,language,representation_version)
);
REVOKE ALL ON "__SCHEMA__".objective_explanation_representation,"__SCHEMA__".objective_explanation_head,
 "__SCHEMA__".writing_explanation_representation,"__SCHEMA__".writing_explanation_head FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";
ALTER TABLE "__SCHEMA__".writing_explanation_representation ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".writing_explanation_representation FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".writing_explanation_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".writing_explanation_head FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_writing_explanations ON "__SCHEMA__".writing_explanation_representation FOR SELECT TO "__LEARNER__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_writing_explanation_heads ON "__SCHEMA__".writing_explanation_head FOR SELECT TO "__LEARNER__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY worker_writing_explanations ON "__SCHEMA__".writing_explanation_representation TO "__WORKER__" USING(true) WITH CHECK(true);
CREATE POLICY worker_writing_explanation_heads ON "__SCHEMA__".writing_explanation_head TO "__WORKER__" USING(true) WITH CHECK(true);
CREATE POLICY deletion_writing_explanations ON "__SCHEMA__".writing_explanation_representation TO "__DELETION__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY deletion_writing_explanation_heads ON "__SCHEMA__".writing_explanation_head TO "__DELETION__"
 USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''));
GRANT SELECT ON "__SCHEMA__".writing_explanation_representation,"__SCHEMA__".writing_explanation_head TO "__LEARNER__";
GRANT SELECT,INSERT ON "__SCHEMA__".writing_explanation_representation,"__SCHEMA__".writing_explanation_head TO "__WORKER__";
GRANT SELECT,DELETE ON "__SCHEMA__".writing_explanation_representation,"__SCHEMA__".writing_explanation_head TO "__DELETION__";

CREATE FUNCTION "__SCHEMA__".guard_explanation_representation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE block jsonb; slots text[]:=ARRAY[]::text[]; maximum integer; actual record; expected_keys text[];
BEGIN
 IF TG_OP='UPDATE' OR (TG_OP='DELETE' AND TG_TABLE_NAME='objective_explanation_representation') THEN RAISE EXCEPTION 'explanation_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF jsonb_typeof(NEW.payload)<>'object' OR NEW.payload-ARRAY['schema','blocks']<>'{}' OR NEW.payload->>'schema' IS DISTINCT FROM 'explanation-text-v1'
  OR jsonb_typeof(NEW.payload->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.payload->'blocks') NOT BETWEEN 1 AND 44 THEN RAISE EXCEPTION 'invalid_explanation' USING ERRCODE='23514'; END IF;
 FOR block IN SELECT value FROM jsonb_array_elements(NEW.payload->'blocks') LOOP
  maximum:=CASE WHEN block->>'slot' LIKE 'correction/%' THEN 1000 ELSE 4000 END;
  IF jsonb_typeof(block)<>'object' OR block-ARRAY['slot','text']<>'{}' OR jsonb_typeof(block->'slot') IS DISTINCT FROM 'string'
   OR length(block->>'slot') NOT BETWEEN 1 AND 160 OR block->>'slot'=ANY(slots) OR jsonb_typeof(block->'text') IS DISTINCT FROM 'string'
   OR length(block->>'text')+length(regexp_replace((block->>'text') COLLATE "C",U&'[\0001-\FFFF]','','g'))>maximum
   OR length(regexp_replace((block->>'text') COLLATE "C",U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]','','g'))=0
  THEN RAISE EXCEPTION 'invalid_explanation' USING ERRCODE='23514'; END IF;
  slots:=array_append(slots,block->>'slot');
 END LOOP;
 expected_keys:=CASE NEW.provenance->>'kind' WHEN 'original-assessment' THEN ARRAY['kind','source_sha256']
  WHEN 'builtin-simulation-dictionary' THEN ARRAY['kind','source_sha256','dictionary_version','dictionary_sha256']
  WHEN 'publisher-authored' THEN ARRAY['kind','source_sha256','producer_version'] ELSE NULL END;
 IF expected_keys IS NULL OR jsonb_typeof(NEW.provenance)<>'object' OR NEW.provenance-expected_keys<>'{}'
  OR NOT NEW.provenance ?& expected_keys OR NEW.provenance->>'source_sha256' IS DISTINCT FROM NEW.source_sha256
 THEN RAISE EXCEPTION 'invalid_explanation_provenance' USING ERRCODE='23514'; END IF;
 IF NEW.provenance->>'kind'='publisher-authored' AND (jsonb_typeof(NEW.provenance->'producer_version') IS DISTINCT FROM 'string' OR NEW.provenance->>'producer_version' COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  OR NEW.provenance->>'kind'='builtin-simulation-dictionary' AND (jsonb_typeof(NEW.provenance->'dictionary_version') IS DISTINCT FROM 'string' OR NEW.provenance->>'dictionary_version' COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR jsonb_typeof(NEW.provenance->'dictionary_sha256') IS DISTINCT FROM 'string' OR NEW.provenance->>'dictionary_sha256' COLLATE "C" !~ '^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'invalid_explanation_provenance' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='objective_explanation_representation' THEN
  IF NEW.provenance->>'kind'<>'publisher-authored' OR slots<>ARRAY['objective/comment'] THEN RAISE EXCEPTION 'invalid_explanation' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.provenance->>'kind' NOT IN ('original-assessment','builtin-simulation-dictionary') THEN RAISE EXCEPTION 'invalid_explanation' USING ERRCODE='23514'; END IF;
  SELECT a.id AS attempt_id,a.exam_id,a.task_id,s.task_version,a.rubric_id,s.rubric_version,f.model_version,f.prompt_version,s.explanation_language
   INTO actual FROM assessments f JOIN submissions s ON s.id=f.submission_id AND s.owner_id=f.owner_id
   JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id WHERE f.submission_id=NEW.submission_id AND f.owner_id=NEW.owner_id;
  IF NOT FOUND OR jsonb_build_array(NEW.attempt_id,NEW.exam_id,NEW.task_id,NEW.task_version,NEW.rubric_id,NEW.rubric_version,NEW.model_version,NEW.prompt_version,NEW.original_language)
   IS DISTINCT FROM jsonb_build_array(actual.attempt_id,actual.exam_id,actual.task_id,actual.task_version,actual.rubric_id,actual.rubric_version,actual.model_version,actual.prompt_version,actual.explanation_language)
  THEN RAISE EXCEPTION 'explanation_source_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_explanation_representation() FROM PUBLIC;
CREATE TRIGGER guard_objective_explanation BEFORE INSERT OR UPDATE OR DELETE ON "__SCHEMA__".objective_explanation_representation FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_explanation_representation();
CREATE TRIGGER guard_writing_explanation BEFORE INSERT OR UPDATE OR DELETE ON "__SCHEMA__".writing_explanation_representation FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_explanation_representation();
CREATE FUNCTION "__SCHEMA__".guard_explanation_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF TG_TABLE_NAME='writing_explanation_head' OR TG_OP='DELETE' OR (to_jsonb(NEW)-'representation_version') IS DISTINCT FROM (to_jsonb(OLD)-'representation_version')
 THEN RAISE EXCEPTION 'explanation_head_immutable' USING ERRCODE='23514'; END IF;RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_explanation_head() FROM PUBLIC;
CREATE TRIGGER guard_objective_explanation_head BEFORE UPDATE OR DELETE ON "__SCHEMA__".objective_explanation_head FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_explanation_head();
CREATE TRIGGER guard_writing_explanation_head BEFORE UPDATE ON "__SCHEMA__".writing_explanation_head FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_explanation_head();
CREATE FUNCTION "__SCHEMA__".guard_explanation_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN RAISE EXCEPTION 'explanation_immutable' USING ERRCODE='23514';END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_explanation_truncate() FROM PUBLIC;
CREATE TRIGGER guard_objective_explanation_truncate BEFORE TRUNCATE ON "__SCHEMA__".objective_explanation_representation FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_explanation_truncate();
CREATE TRIGGER guard_objective_explanation_head_truncate BEFORE TRUNCATE ON "__SCHEMA__".objective_explanation_head FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_explanation_truncate();
CREATE TRIGGER guard_writing_explanation_truncate BEFORE TRUNCATE ON "__SCHEMA__".writing_explanation_representation FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_explanation_truncate();
CREATE TRIGGER guard_writing_explanation_head_truncate BEFORE TRUNCATE ON "__SCHEMA__".writing_explanation_head FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_explanation_truncate();

-- Actual coherent export snapshots are the only no-lock path. No caller policy GUC.
CREATE FUNCTION "__SCHEMA__".explanation_read_owner() RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text:=nullif(current_setting('hatoove.owner_id',true),'');
BEGIN
 IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF current_setting('transaction_isolation')='read committed' THEN PERFORM pg_advisory_xact_lock(hashtextextended(who,7352));
 ELSIF NOT (current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on')
 THEN RAISE EXCEPTION 'explanation_isolation_required' USING ERRCODE='25000'; END IF;
 RETURN who;
END $fn$;
CREATE FUNCTION "__SCHEMA__".explanation_read_exam(p_exam text) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN IF current_setting('transaction_isolation')='read committed' THEN PERFORM pg_advisory_xact_lock(hashtextextended(p_exam,7351)); END IF;END $fn$;
CREATE FUNCTION "__SCHEMA__".explanation_require_content(p_id text) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM content_version c LEFT JOIN content_rights cr USING(content_version_id)
  CROSS JOIN LATERAL effective_content_review(c.content_version_id) r WHERE c.content_version_id=p_id
  AND coalesce(cr.basis,c.rights_status) IN ('generated','licensed','commissioned') AND r.review_status IN ('approved','unreviewed','rejected','withdrawn'))
 THEN RAISE EXCEPTION 'explanation_content_blocked' USING ERRCODE='P0001'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".explanation_read_owner(),"__SCHEMA__".explanation_read_exam(text),"__SCHEMA__".explanation_require_content(text) FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".explanation_item_envelope(p_context jsonb,p_original jsonb,p_language text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE n integer; representations jsonb; heads jsonb;
BEGIN
 IF p_language IS NOT NULL AND p_language NOT IN ('de','en','uk','ar','tr') THEN RAISE EXCEPTION 'invalid_explanation_language' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO n FROM(SELECT 1 FROM objective_explanation_head h JOIN objective_explanation_representation r
  USING(set_id,set_version,item_id,source_sha256,language,representation_version)
  WHERE r.exam_id=p_context->>'exam_id' AND h.set_id=p_context->>'set_id' AND h.set_version=p_context->>'set_version' AND h.item_id=p_context->>'item_id' LIMIT 101) bounded;
 IF n>100 THEN RAISE EXCEPTION 'explanation_candidate_limit' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('language',r.language,'version',r.representation_version,'source_sha256',r.source_sha256,
  'payload',r.payload,'payload_sha256',r.payload_sha256,'provenance',r.provenance) ORDER BY r.language,r.source_sha256,r.representation_version),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('language',r.language,'source_sha256',r.source_sha256,'representation_version',r.representation_version)
  ORDER BY r.language,r.source_sha256,r.representation_version),'[]') INTO representations,heads
  FROM objective_explanation_head h JOIN objective_explanation_representation r USING(set_id,set_version,item_id,source_sha256,language,representation_version)
  WHERE r.exam_id=p_context->>'exam_id' AND h.set_id=p_context->>'set_id' AND h.set_version=p_context->>'set_version' AND h.item_id=p_context->>'item_id';
 RETURN jsonb_build_object('kind','objective','context',p_context,'originalValue',coalesce(p_original,'null'),'representations',representations,'heads',heads);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".explanation_item_envelope(jsonb,jsonb,text) FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".read_objective_evidence_explanation(p_evidence_id uuid,p_language text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text; bound_exam text; e record; s record; interaction text; interactions integer; rows jsonb; item jsonb; choices jsonb; identity text; matches integer:=0; original jsonb;
BEGIN
 who:=explanation_read_owner();SELECT exam_id INTO bound_exam FROM item_evidence WHERE evidence_id=p_evidence_id AND owner_id=who;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;PERFORM explanation_read_exam(bound_exam);
 SELECT ev.* INTO e FROM item_evidence ev JOIN learner_preparation p ON p.id=ev.preparation_id AND p.owner_id=ev.owner_id AND p.exam_id=ev.exam_id
  WHERE ev.evidence_id=p_evidence_id AND ev.owner_id=who AND ev.mock_run_id IS NULL AND p.state IN ('active','archived');
 IF NOT FOUND OR jsonb_typeof(e.answer) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT o.*,c.source_path INTO s FROM objective_set o JOIN content_version c USING(content_version_id)
  WHERE o.set_id=e.set_id AND o.version=e.version AND o.exam_id=e.exam_id AND NOT o.media_required;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;PERFORM explanation_require_content(s.content_version_id);
 IF EXISTS(SELECT 1 FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version
  JOIN exam_release_form rf ON rf.exam_id=r.exam_id AND coalesce(r.manifest#>'{release,resumeBlockedReleases}','[]') ? rf.release_version
  JOIN exam_form_member m ON m.exam_id=rf.exam_id AND m.form_id=rf.form_id AND m.form_version=rf.form_version WHERE m.set_id=e.set_id AND m.set_version=e.version)
 THEN RAISE EXCEPTION 'explanation_content_blocked' USING ERRCODE='P0001'; END IF;
 SELECT count(DISTINCT m.interaction),min(m.interaction) INTO interactions,interaction FROM exam_form_member m WHERE m.exam_id=e.exam_id AND m.set_id=e.set_id AND m.set_version=e.version;
 IF interactions=0 AND s.source_path NOT LIKE 'content/exams/%' THEN interaction:=CASE s.family WHEN 'LV1' THEN 'matching_headlines' WHEN 'LV2' THEN 'single_choice' WHEN 'LV3' THEN 'matching_ads' WHEN 'SB1' THEN 'gap_choice' WHEN 'SB2' THEN 'gap_bank' END;
 ELSIF interactions<>1 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF interaction='grouped_choice' THEN SELECT jsonb_agg(q.value) INTO rows FROM jsonb_array_elements(s.payload->'groups') g CROSS JOIN LATERAL jsonb_array_elements(g->'questions') q;
 ELSE rows:=s.payload->CASE interaction WHEN 'matching_headlines' THEN 'texts' WHEN 'matching_ads' THEN 'situations' WHEN 'single_choice' THEN 'questions' WHEN 'gap_choice' THEN 'gaps' WHEN 'gap_bank' THEN 'gaps' END; END IF;
 IF jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
  identity:=s6_payload_identity(item->CASE WHEN interaction='matching_headlines' THEN 'id' ELSE 'n' END,32);
  IF identity=e.item_id THEN
   matches:=matches+1;
   IF interaction IN ('matching_headlines','matching_ads','gap_bank') THEN
    choices:=s.payload->CASE interaction WHEN 'matching_headlines' THEN 'headlines' WHEN 'matching_ads' THEN 'ads' ELSE 'bank' END;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(choices) v WHERE v->'id'=e.answer) AND NOT(interaction='matching_ads' AND e.answer='"x"'::jsonb)
    THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
   ELSIF jsonb_typeof(item->'options') IS DISTINCT FROM 'object' OR NOT (item->'options') ? (e.answer#>>'{}') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  END IF;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(k.explanations->e.item_id,k.explanations#>ARRAY['_set_why',e.item_id],'null') INTO original FROM objective_key k WHERE k.set_id=e.set_id AND k.version=e.version AND k.answers ? e.item_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 RETURN explanation_item_envelope(jsonb_build_object('exam_id',e.exam_id,'set_id',e.set_id,'set_version',e.version,'item_id',e.item_id,'evidence_id',e.evidence_id),original,p_language);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".read_objective_evidence_explanation(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".read_objective_evidence_explanation(uuid,text) TO "__LEARNER__";

CREATE FUNCTION "__SCHEMA__".read_finalised_mock_item_explanation(p_run_id uuid,p_set_id text,p_set_version text,p_item_id text,p_language text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text; bound_exam text; run mock_run%ROWTYPE; form record; member record; item jsonb; n integer; review record; reference jsonb; cv text; task record;
BEGIN
 who:=explanation_read_owner();SELECT exam_id INTO bound_exam FROM mock_run WHERE id=p_run_id AND owner_id=who;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;PERFORM explanation_read_exam(bound_exam);
 SELECT r.* INTO run FROM mock_run r JOIN learner_preparation p ON p.id=r.preparation_id AND p.owner_id=r.owner_id AND p.exam_id=r.exam_id
  WHERE r.id=p_run_id AND r.owner_id=who AND r.state='finalised' AND p.state IN ('active','archived');
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT f.* INTO form FROM exam_form f JOIN exam_release_form rf ON rf.exam_id=f.exam_id AND rf.form_id=f.form_id AND rf.form_version=f.version
  WHERE f.exam_id=run.exam_id AND f.form_id=run.form_id AND f.version=run.form_version AND f.blueprint_version=run.blueprint_version AND rf.release_version=run.release_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version WHERE r.exam_id=run.exam_id AND coalesce(r.manifest#>'{release,resumeBlockedReleases}','[]') ? run.release_version)
 THEN RAISE EXCEPTION 'explanation_content_blocked' USING ERRCODE='P0001'; END IF;
 FOR review IN SELECT * FROM effective_format_review(run.exam_id,'form',run.form_id,run.form_version) UNION ALL SELECT * FROM effective_format_review(run.exam_id,'blueprint',run.exam_id,run.blueprint_version) LOOP
  IF review.review_status NOT IN ('approved','unreviewed','rejected','withdrawn') THEN RAISE EXCEPTION 'explanation_content_blocked' USING ERRCODE='P0001'; END IF;
 END LOOP;
 FOR member IN SELECT s.*,m.interaction FROM exam_form_member m JOIN objective_set s ON s.set_id=m.set_id AND s.version=m.set_version AND s.exam_id=m.exam_id
  WHERE m.exam_id=run.exam_id AND m.form_id=run.form_id AND m.form_version=run.form_version LOOP
  PERFORM explanation_require_content(member.content_version_id);
  IF member.media_required THEN FOR reference IN SELECT value FROM jsonb_array_elements(member.payload->'recordings') LOOP
   SELECT content_version_id INTO cv FROM exam_media WHERE exam_id=run.exam_id AND media_id=reference->>'mediaId' AND version=reference->>'mediaVersion';PERFORM explanation_require_content(cv);
  END LOOP;END IF;
 END LOOP;
 FOR reference IN SELECT o.value FROM jsonb_array_elements(coalesce(form.payload->'writingChoices','[]')) g CROSS JOIN LATERAL jsonb_array_elements(g->'options') o
  UNION ALL SELECT form.payload->'writingTask' WHERE jsonb_typeof(form.payload->'writingTask')='object' LOOP
  SELECT t.content_version_id,r.content_version_id AS rubric_content INTO task FROM task_version t JOIN rubric_version r ON r.rubric_id=t.rubric_id AND r.version=t.rubric_version AND r.exam_id=t.exam_id
   WHERE t.exam_id=run.exam_id AND t.task_id=reference->>'taskId' AND t.version=reference->>'taskVersion';
  IF NOT FOUND THEN RAISE EXCEPTION 'explanation_content_blocked' USING ERRCODE='P0001'; END IF;
  PERFORM explanation_require_content(task.content_version_id);PERFORM explanation_require_content(task.rubric_content);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM exam_form_member m WHERE m.exam_id=run.exam_id AND m.form_id=run.form_id AND m.form_version=run.form_version AND m.set_id=p_set_id AND m.set_version=p_set_version)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(run.result->'items') i WHERE i->>'set_id'=p_set_id AND i->>'version'=p_set_version AND i->>'item_id'=p_item_id;
 IF n<>1 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT i INTO item FROM jsonb_array_elements(run.result->'items') i WHERE i->>'set_id'=p_set_id AND i->>'version'=p_set_version AND i->>'item_id'=p_item_id;
 RETURN explanation_item_envelope(jsonb_build_object('exam_id',run.exam_id,'set_id',p_set_id,'set_version',p_set_version,'item_id',p_item_id,'run_id',run.id),item->'explanation',p_language);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".read_finalised_mock_item_explanation(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".read_finalised_mock_item_explanation(uuid,text,text,text,text) TO "__LEARNER__";

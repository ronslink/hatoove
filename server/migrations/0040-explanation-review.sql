-- C06 shared explanation targets. No source, assessment, baseline or review approval is rewritten.
ALTER TABLE "__SCHEMA__".objective_set ADD CONSTRAINT objective_set_review_binding UNIQUE(set_id,version,exam_id,content_version_id);
ALTER TABLE "__SCHEMA__".objective_explanation_representation ADD CONSTRAINT objective_explanation_review_binding UNIQUE(set_id,set_version,item_id,source_sha256,language,representation_version,exam_id,payload_sha256);
CREATE TABLE "__SCHEMA__".explanation_review_target (
 target_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_kind text NOT NULL CHECK(target_kind IN ('stored','original')),
 exam_id text NOT NULL,set_id text NOT NULL,set_version text NOT NULL,item_id text NOT NULL,
 content_version_id text NOT NULL, source_sha256 text NOT NULL CHECK(source_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),
 language text NOT NULL CHECK(language IN ('de','en','uk','ar','tr')),
 representation_version text NOT NULL CHECK(representation_version COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 payload_sha256 text NOT NULL CHECK(payload_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),stored_representation_version text,
 extraction_version text NOT NULL CHECK(extraction_version='explanation-source-v1'),
 original_language text NOT NULL CHECK(original_language IN ('de','en','uk','ar','tr')),
 original_format text NOT NULL CHECK(original_format='objective-string'),original_value_fingerprint text NOT NULL,
 packet_sha256 text NOT NULL CHECK(packet_sha256 COLLATE "C" ~ '^[a-f0-9]{64}$'),target_sha256 text NOT NULL,
 registered_at timestamptz NOT NULL,registered_by text NOT NULL,
 FOREIGN KEY(set_id,set_version,exam_id,content_version_id) REFERENCES "__SCHEMA__".objective_set(set_id,version,exam_id,content_version_id),
 FOREIGN KEY(set_id,set_version,item_id,source_sha256,language,stored_representation_version,exam_id,payload_sha256)
  REFERENCES "__SCHEMA__".objective_explanation_representation(set_id,set_version,item_id,source_sha256,language,representation_version,exam_id,payload_sha256),
 CHECK((target_kind='stored' AND stored_representation_version IS NOT NULL AND stored_representation_version=representation_version)
   OR(target_kind='original' AND stored_representation_version IS NULL AND representation_version='legacy-projection-v1' AND original_language=language)),
 UNIQUE(target_kind,exam_id,set_id,set_version,item_id,source_sha256,language,representation_version,payload_sha256)
);
REVOKE ALL ON "__SCHEMA__".explanation_review_target FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";
CREATE TRIGGER explanation_review_target_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".explanation_review_target FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();
CREATE TRIGGER explanation_review_target_no_truncate BEFORE TRUNCATE ON "__SCHEMA__".explanation_review_target FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".content_immutable();

-- Private source resolver: immutable same-exam backing, exact trusted item and key, no personal tables.
CREATE FUNCTION "__SCHEMA__".resolve_explanation_review_source(e text,s text,v text,i text)
 RETURNS TABLE(content_version_id text,content_sha256 text,original_value jsonb,original_value_fingerprint text,interaction text)
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE r record; n integer; rows jsonb; item jsonb; bank jsonb; choices text[]; ids text[]:=ARRAY[]::text[]; itemid text; label text;
BEGIN
 IF e IS NULL OR s IS NULL OR v IS NULL OR i IS NULL OR e COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  OR s COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' OR v COLLATE "C" !~ '^v[0-9]{1,4}$' OR i COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' THEN RETURN; END IF;
 SELECT o.*,c.content_sha256,c.source_path,k.answers,k.explanations INTO r FROM objective_set o JOIN content_version c USING(content_version_id) JOIN objective_key k ON k.set_id=o.set_id AND k.version=o.version
  WHERE o.exam_id=e AND o.set_id=s AND o.version=v AND c.exam_id=e AND c.kind='task';
 IF NOT FOUND OR r.content_sha256 !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
 SELECT count(DISTINCT m.interaction),min(m.interaction) INTO n,interaction FROM exam_form_member m WHERE m.exam_id=e AND m.set_id=s AND m.set_version=v;
 IF n=0 AND r.source_path NOT LIKE 'content/exams/%' THEN interaction:=CASE r.family WHEN 'LV1' THEN 'matching_headlines' WHEN 'LV2' THEN 'single_choice' WHEN 'LV3' THEN 'matching_ads' WHEN 'SB1' THEN 'gap_choice' WHEN 'SB2' THEN 'gap_bank' END;
 ELSIF n<>1 THEN RETURN; END IF;
 IF interaction IN ('fixed_audio','grouped_choice','single_choice','matching_ads','gap_choice') THEN
  IF NOT complete_dtz_objective_eligible(r.payload,interaction,r.item_count,r.answers) THEN RETURN; END IF;
  IF interaction IN ('fixed_audio','grouped_choice') THEN
   SELECT jsonb_agg(q.value) INTO rows FROM jsonb_array_elements(r.payload->CASE WHEN interaction='fixed_audio' THEN 'recordings' ELSE 'groups' END) g CROSS JOIN LATERAL jsonb_array_elements(g->'questions') q;
  ELSE rows:=r.payload->CASE WHEN interaction='single_choice' THEN 'questions' WHEN interaction='matching_ads' THEN 'situations' ELSE 'gaps' END; END IF;
 ELSIF interaction IN ('matching_headlines','gap_bank') THEN
  IF jsonb_typeof(r.payload) IS DISTINCT FROM 'object' OR EXISTS(WITH RECURSIVE nodes(value) AS (
   SELECT r.payload UNION ALL SELECT child.value FROM nodes n CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END)
    UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END)
   ) child)
   SELECT 1 FROM nodes n CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) key
   WHERE key COLLATE "C" ~* '^(answer|answers|answer_key|correct|correct_answer|solution|solutions|why|grammar|explanation|explanations|script|transcript)$') THEN RETURN; END IF;
  rows:=r.payload->CASE WHEN interaction='matching_headlines' THEN 'texts' ELSE 'gaps' END;bank:=r.payload->CASE WHEN interaction='matching_headlines' THEN 'headlines' ELSE 'bank' END;label:=CASE WHEN interaction='matching_headlines' THEN 'text' ELSE 'word' END;
  IF jsonb_typeof(bank) IS DISTINCT FROM 'array' OR jsonb_array_length(bank) NOT BETWEEN 2 AND 50 OR jsonb_typeof(rows) IS DISTINCT FROM 'array'
   OR jsonb_array_length(rows) NOT BETWEEN 1 AND 100 OR jsonb_array_length(rows)<>r.item_count OR jsonb_typeof(r.answers) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r.answers))<>r.item_count OR (interaction='gap_bank' AND NOT s6_payload_text(r.payload->'letter',100000)) THEN RETURN; END IF;
  choices:=ARRAY[]::text[];
  FOR item IN SELECT value FROM jsonb_array_elements(bank) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT s6_payload_text(item->'id',32) OR NOT s6_payload_text(item->label,20000) OR item->>'id'=ANY(choices) THEN RETURN; END IF;
   choices:=array_append(choices,item->>'id');
  END LOOP;
 ELSE RETURN; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
  itemid:=s6_payload_identity(item->CASE WHEN interaction='matching_headlines' THEN 'id' ELSE 'n' END,32);
  IF itemid IS NULL OR itemid=ANY(ids) OR (interaction<>'matching_headlines' AND item?'id' AND s6_payload_identity(item->'id',32) IS DISTINCT FROM itemid) THEN RETURN; END IF;
  ids:=array_append(ids,itemid);
  IF interaction IN ('matching_headlines','gap_bank') AND (jsonb_typeof(r.answers->itemid) IS DISTINCT FROM 'string' OR NOT coalesce(r.answers->>itemid=ANY(choices),false)) THEN RETURN; END IF;
  IF interaction='matching_headlines' AND NOT s6_payload_text(item->'text',20000) THEN RETURN; END IF;
 END LOOP;
 IF NOT i=ANY(ids) THEN RETURN; END IF;
 original_value:=coalesce(nullif(r.explanations->i,'null'),nullif(r.explanations#>ARRAY['_set_why',i],'null'),'null');
 IF NOT s6_payload_text(original_value,4000) OR length(regexp_replace(original_value#>>'{}',U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]','','g'))=0 THEN RETURN; END IF;
 content_version_id:=r.content_version_id;content_sha256:=r.content_sha256;original_value_fingerprint:=encode(sha256(convert_to(original_value::text,'UTF8')),'hex');RETURN NEXT;
EXCEPTION WHEN data_exception OR null_value_not_allowed THEN RETURN;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".resolve_explanation_review_source(text,text,text,text) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

CREATE FUNCTION "__SCHEMA__".validate_explanation_review_target() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE source record; identity jsonb;
BEGIN
 IF current_user<>(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='__SCHEMA__') THEN RAISE EXCEPTION 'review_operator_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'review_read_committed_required' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.exam_id,7351));
 SELECT * INTO source FROM resolve_explanation_review_source(NEW.exam_id,NEW.set_id,NEW.set_version,NEW.item_id);
 IF NOT FOUND OR source.content_version_id IS DISTINCT FROM NEW.content_version_id THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM content_version c LEFT JOIN content_rights r USING(content_version_id) WHERE c.content_version_id=source.content_version_id AND coalesce(r.basis,c.rights_status) IN ('generated','licensed','commissioned')) THEN RAISE EXCEPTION 'review_rights_blocked' USING ERRCODE='23514'; END IF;
 IF NEW.target_kind='stored' AND NOT EXISTS(SELECT 1 FROM objective_explanation_representation r WHERE (r.exam_id,r.set_id,r.set_version,r.item_id,r.source_sha256,r.language,r.representation_version,r.payload_sha256,r.original_language,r.original_format)=(NEW.exam_id,NEW.set_id,NEW.set_version,NEW.item_id,NEW.source_sha256,NEW.language,NEW.representation_version,NEW.payload_sha256,NEW.original_language,NEW.original_format)) THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
 NEW.original_value_fingerprint:=source.original_value_fingerprint;
 identity:=jsonb_build_object('format','explanation-review-target-v1','scope','objective','targetKind',NEW.target_kind,'sourceIdentity',jsonb_build_object('exam_id',NEW.exam_id,'set_id',NEW.set_id,'set_version',NEW.set_version,'item_id',NEW.item_id),
  'sourceSha256',NEW.source_sha256,'language',NEW.language,'representationVersion',NEW.representation_version,'payloadSha256',NEW.payload_sha256,'contentIdentity',jsonb_build_object('content_version_id',source.content_version_id,'content_sha256',source.content_sha256),
  'extractionVersion',NEW.extraction_version,'originalLanguage',NEW.original_language,'originalFormat',NEW.original_format,'originalValueFingerprint',NEW.original_value_fingerprint,'packetSha256',NEW.packet_sha256);
 NEW.target_sha256:=encode(sha256(convert_to(identity::text,'UTF8')),'hex');NEW.registered_at:=clock_timestamp();NEW.registered_by:=session_user;RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".validate_explanation_review_target() FROM PUBLIC;
CREATE TRIGGER explanation_review_target_insert BEFORE INSERT ON "__SCHEMA__".explanation_review_target FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".validate_explanation_review_target();

CREATE FUNCTION "__SCHEMA__".register_explanation_review_target(p jsonb) RETURNS SETOF "__SCHEMA__".explanation_review_target LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE old explanation_review_target%ROWTYPE;
BEGIN
 IF current_user<>(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='__SCHEMA__') THEN RAISE EXCEPTION 'review_operator_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'review_read_committed_required' USING ERRCODE='25000'; END IF;
 PERFORM review_input_strings(p,ARRAY['target_kind','exam_id','set_id','set_version','item_id','content_version_id','source_sha256','language','representation_version','payload_sha256','extraction_version','original_language','original_format','packet_sha256']);
 IF p-ARRAY['target_kind','exam_id','set_id','set_version','item_id','content_version_id','source_sha256','language','representation_version','payload_sha256','extraction_version','original_language','original_format','packet_sha256']<>'{}' THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'exam_id',7351));
 SELECT * INTO old FROM explanation_review_target t WHERE (t.target_kind,t.exam_id,t.set_id,t.set_version,t.item_id,t.source_sha256,t.language,t.representation_version,t.payload_sha256)=(p->>'target_kind',p->>'exam_id',p->>'set_id',p->>'set_version',p->>'item_id',p->>'source_sha256',p->>'language',p->>'representation_version',p->>'payload_sha256');
 IF FOUND THEN
  IF (old.content_version_id,old.extraction_version,old.original_language,old.original_format,old.packet_sha256) IS DISTINCT FROM (p->>'content_version_id',p->>'extraction_version',p->>'original_language',p->>'original_format',p->>'packet_sha256') THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEXT old;RETURN;
 END IF;
 RETURN QUERY INSERT INTO explanation_review_target(target_kind,exam_id,set_id,set_version,item_id,content_version_id,source_sha256,language,representation_version,payload_sha256,stored_representation_version,extraction_version,original_language,original_format,packet_sha256)
  VALUES(p->>'target_kind',p->>'exam_id',p->>'set_id',p->>'set_version',p->>'item_id',p->>'content_version_id',p->>'source_sha256',p->>'language',p->>'representation_version',p->>'payload_sha256',CASE WHEN p->>'target_kind'='stored' THEN p->>'representation_version' END,p->>'extraction_version',p->>'original_language',p->>'original_format',p->>'packet_sha256') RETURNING *;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".register_explanation_review_target(jsonb) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

CREATE FUNCTION "__SCHEMA__".resolve_explanation_review_target(e text,i text,v text)
 RETURNS TABLE(exam_id text,subject_sha256 text,language text,packet_sha256 text,content_version_id text)
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF i IS NULL OR i COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN; END IF;
 RETURN QUERY SELECT t.exam_id,t.target_sha256,t.language,t.packet_sha256,t.content_version_id FROM explanation_review_target t
 CROSS JOIN LATERAL resolve_explanation_review_source(t.exam_id,t.set_id,t.set_version,t.item_id) s
 WHERE t.target_id=i::uuid AND t.exam_id=e AND t.representation_version=v AND s.content_version_id=t.content_version_id AND s.original_value_fingerprint=t.original_value_fingerprint;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".resolve_explanation_review_target(text,text,text) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

ALTER TABLE "__SCHEMA__".content_review_decision ADD COLUMN explanation_target_id uuid REFERENCES "__SCHEMA__".explanation_review_target(target_id);
ALTER TABLE "__SCHEMA__".content_review_decision DROP CONSTRAINT content_review_decision_subject_kind_check;
ALTER TABLE "__SCHEMA__".content_review_decision ADD CONSTRAINT content_review_decision_subject_kind_check CHECK(subject_kind IN ('content','blueprint','form','explanation'));
ALTER TABLE "__SCHEMA__".content_review_decision DROP CONSTRAINT content_review_decision_check;
ALTER TABLE "__SCHEMA__".content_review_decision ADD CONSTRAINT content_review_decision_check CHECK(
 (subject_kind='content' AND content_version_id IS NOT NULL AND content_version_id=subject_id AND subject_version='' AND blueprint_version IS NULL AND form_id IS NULL AND form_version IS NULL AND explanation_target_id IS NULL)
 OR(subject_kind='blueprint' AND content_version_id IS NULL AND blueprint_version IS NOT NULL AND subject_id=exam_id AND blueprint_version=subject_version AND form_id IS NULL AND form_version IS NULL AND explanation_target_id IS NULL)
 OR(subject_kind='form' AND content_version_id IS NULL AND blueprint_version IS NULL AND form_id IS NOT NULL AND form_version IS NOT NULL AND form_id=subject_id AND form_version=subject_version AND explanation_target_id IS NULL)
 OR(subject_kind='explanation' AND explanation_target_id IS NOT NULL AND explanation_target_id::text=subject_id AND content_version_id IS NULL AND blueprint_version IS NULL AND form_id IS NULL AND form_version IS NULL));
CREATE OR REPLACE FUNCTION "__SCHEMA__".review_decision_insert() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE old record; head record; auth record; subject record; payload jsonb; current_authority uuid;
BEGIN
 IF current_user<>(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='__SCHEMA__') THEN RAISE EXCEPTION 'review_operator_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'review_read_committed_required' USING ERRCODE='25000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "__SCHEMA__".exam_package WHERE exam_id=NEW.exam_id) THEN RAISE EXCEPTION 'review_subject_unavailable' USING ERRCODE='23503'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.exam_id,7351));
 payload:=jsonb_build_object('eventId',NEW.event_id,'subject',jsonb_build_object('kind',NEW.subject_kind,'examId',NEW.exam_id,'subjectId',NEW.subject_id,'version',NEW.subject_version,'sha256',NEW.subject_sha256),
  'category',NEW.category,'language',NEW.language,'authorityId',NEW.authority_id,'expectedDecisionId',NEW.supersedes_decision_id,'decision',NEW.decision,
  'evidenceRef',NEW.evidence_ref,'evidenceSha256',NEW.evidence_sha256,'rationale',NEW.rationale,'packetSha256',NEW.packet_sha256);
 SELECT * INTO old FROM "__SCHEMA__".content_review_decision WHERE event_id=NEW.event_id;
 IF FOUND THEN
  IF old.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'review_event_conflict' USING ERRCODE='23505'; END IF;
  RETURN NULL;
 END IF;
 IF NEW.subject_kind='explanation' THEN
  SELECT * INTO subject FROM resolve_explanation_review_target(NEW.exam_id,NEW.subject_id,NEW.subject_version);
  IF NOT FOUND OR subject.subject_sha256 IS DISTINCT FROM NEW.subject_sha256 OR NEW.explanation_target_id::text IS DISTINCT FROM NEW.subject_id THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
  IF NOT ((NEW.category='educational' AND NEW.language='') OR (NEW.category='language' AND NEW.language=subject.language)) THEN RAISE EXCEPTION 'review_scope_invalid' USING ERRCODE='23514'; END IF;
  IF NEW.decision='approve' THEN
   IF NEW.packet_sha256 IS DISTINCT FROM subject.packet_sha256 THEN RAISE EXCEPTION 'review_packet_mismatch' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM content_version c LEFT JOIN content_rights r USING(content_version_id) WHERE c.content_version_id=subject.content_version_id AND coalesce(r.basis,c.rights_status) IN ('generated','licensed','commissioned')) THEN RAISE EXCEPTION 'review_rights_blocked' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
 SELECT * INTO subject FROM "__SCHEMA__".resolve_review_subject(NEW.subject_kind,NEW.exam_id,NEW.subject_id,NEW.subject_version);
 IF NOT FOUND OR subject.subject_sha256 IS DISTINCT FROM NEW.subject_sha256 THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.category IS DISTINCT FROM subject.category OR NEW.language IS DISTINCT FROM subject.language THEN RAISE EXCEPTION 'review_scope_invalid' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO auth FROM "__SCHEMA__".content_review_authority WHERE authority_id=NEW.authority_id;
 IF NOT FOUND OR auth.action<>'grant' OR auth.exam_id<>NEW.exam_id OR auth.category<>NEW.category OR auth.language<>NEW.language THEN RAISE EXCEPTION 'review_authority_unavailable' USING ERRCODE='23514'; END IF;
 SELECT authority_id INTO current_authority FROM "__SCHEMA__".content_review_authority WHERE reviewer_id=auth.reviewer_id AND exam_id=auth.exam_id AND category=auth.category AND language=auth.language ORDER BY revision DESC LIMIT 1;
 IF current_authority IS DISTINCT FROM NEW.authority_id THEN RAISE EXCEPTION 'review_authority_unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO head FROM "__SCHEMA__".content_review_decision WHERE exam_id=NEW.exam_id AND subject_kind=NEW.subject_kind AND subject_id=NEW.subject_id AND subject_version=NEW.subject_version AND subject_sha256=NEW.subject_sha256 AND category=NEW.category AND language=NEW.language ORDER BY revision DESC LIMIT 1;
 IF NEW.supersedes_decision_id IS DISTINCT FROM head.decision_id THEN RAISE EXCEPTION 'review_head_conflict' USING ERRCODE='40001'; END IF;
 NEW.revision:=coalesce(head.revision,0)+1;NEW.request_payload:=payload;
 NEW.request_sha256:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 NEW.recorded_at:=clock_timestamp();NEW.recorded_by:=session_user;RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".review_decision_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION "__SCHEMA__".append_content_review(p jsonb) RETURNS SETOF "__SCHEMA__".content_review_decision
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE s jsonb:=p->'subject'; k text;
BEGIN
 PERFORM "__SCHEMA__".review_input_strings(p,ARRAY['eventId','category','language','authorityId','decision','evidenceRef','evidenceSha256','rationale']);
 PERFORM "__SCHEMA__".review_input_strings(s,ARRAY['kind','examId','subjectId','version','sha256']);k:=s->>'kind';
 IF p-ARRAY['eventId','subject','category','language','authorityId','expectedDecisionId','decision','evidenceRef','evidenceSha256','rationale','packetSha256']<>'{}'::jsonb
  OR s-ARRAY['kind','examId','subjectId','version','sha256']<>'{}'::jsonb OR NOT p?'expectedDecisionId'
  OR jsonb_typeof(p->'expectedDecisionId') NOT IN ('string','null')
  OR (p?'packetSha256' AND jsonb_typeof(p->'packetSha256') NOT IN ('string','null')) THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 RETURN QUERY INSERT INTO "__SCHEMA__".content_review_decision(event_id,exam_id,subject_kind,subject_id,subject_version,subject_sha256,content_version_id,blueprint_version,form_id,form_version,explanation_target_id,category,language,authority_id,supersedes_decision_id,decision,evidence_ref,evidence_sha256,rationale,packet_sha256)
  VALUES((p->>'eventId')::uuid,s->>'examId',k,s->>'subjectId',s->>'version',s->>'sha256',CASE WHEN k='content' THEN s->>'subjectId' END,CASE WHEN k='blueprint' THEN s->>'version' END,CASE WHEN k='form' THEN s->>'subjectId' END,CASE WHEN k='form' THEN s->>'version' END,CASE WHEN k='explanation' THEN (s->>'subjectId')::uuid END,
  p->>'category',p->>'language',(p->>'authorityId')::uuid,(p->>'expectedDecisionId')::uuid,p->>'decision',p->>'evidenceRef',p->>'evidenceSha256',p->>'rationale',p->>'packetSha256') RETURNING *;
 IF NOT FOUND THEN RETURN QUERY SELECT * FROM "__SCHEMA__".content_review_decision WHERE event_id=(p->>'eventId')::uuid; END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".append_content_review(jsonb) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

CREATE FUNCTION "__SCHEMA__".effective_explanation_review(p_exam_id text,p_set_id text,p_set_version text,p_item_id text,p_source_sha256 text,p_language text,p_representation_version text,p_payload_sha256 text,p_target_kind text)
 RETURNS TABLE(dimension text,review_status text,review_basis text,blocked boolean,explicit_negative boolean,decision_ids uuid[])
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE source record; target explanation_review_target%ROWTYPE; head record; valid boolean:=true; category_value text; language_value text;
BEGIN
 IF p_source_sha256 IS NULL OR p_payload_sha256 IS NULL OR p_language IS NULL OR p_representation_version IS NULL OR p_target_kind IS NULL
  OR p_source_sha256 COLLATE "C" !~ '^[a-f0-9]{64}$' OR p_payload_sha256 COLLATE "C" !~ '^[a-f0-9]{64}$' OR p_language NOT IN ('de','en','uk','ar','tr')
  OR p_representation_version COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_target_kind NOT IN ('stored','original') OR (p_target_kind='original' AND p_representation_version<>'legacy-projection-v1') THEN valid:=false; END IF;
 SELECT * INTO source FROM resolve_explanation_review_source(p_exam_id,p_set_id,p_set_version,p_item_id);IF NOT FOUND THEN valid:=false; END IF;
 IF valid AND p_target_kind='stored' AND NOT EXISTS(SELECT 1 FROM objective_explanation_representation r WHERE (r.exam_id,r.set_id,r.set_version,r.item_id,r.source_sha256,r.language,r.representation_version,r.payload_sha256)=(p_exam_id,p_set_id,p_set_version,p_item_id,p_source_sha256,p_language,p_representation_version,p_payload_sha256)) THEN valid:=false; END IF;
 IF valid THEN
  SELECT * INTO target FROM explanation_review_target t WHERE (t.exam_id,t.set_id,t.set_version,t.item_id,t.source_sha256,t.language,t.representation_version,t.payload_sha256,t.target_kind)=(p_exam_id,p_set_id,p_set_version,p_item_id,p_source_sha256,p_language,p_representation_version,p_payload_sha256,p_target_kind);
  IF FOUND AND (target.content_version_id IS DISTINCT FROM source.content_version_id OR target.original_value_fingerprint IS DISTINCT FROM source.original_value_fingerprint) THEN valid:=false; END IF;
 END IF;
 FOREACH dimension IN ARRAY ARRAY['educational','native_language'] LOOP
  review_status:=CASE WHEN valid THEN 'unreviewed' ELSE 'unavailable' END;review_basis:='none';blocked:=NOT valid;explicit_negative:=false;decision_ids:=ARRAY[]::uuid[];
  IF valid AND target.target_id IS NOT NULL THEN
   category_value:=CASE WHEN dimension='educational' THEN 'educational' ELSE 'language' END;language_value:=CASE WHEN dimension='educational' THEN '' ELSE target.language END;
   SELECT d.* INTO head FROM content_review_decision d WHERE d.exam_id=target.exam_id AND d.subject_kind='explanation' AND d.subject_id=target.target_id::text AND d.subject_version=target.representation_version
    AND d.subject_sha256=target.target_sha256 AND d.category=category_value AND d.language=language_value ORDER BY d.revision DESC LIMIT 1;
   IF FOUND THEN review_status:=CASE head.decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END;review_basis:='named_decision';blocked:=head.decision<>'approve';explicit_negative:=blocked;decision_ids:=ARRAY[head.decision_id];END IF;
  END IF;
  RETURN NEXT;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".effective_explanation_review(text,text,text,text,text,text,text,text,text) FROM PUBLIC,"__AUTH__","__DELETION__","__PAYMENTS__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".effective_explanation_review(text,text,text,text,text,text,text,text,text) TO "__LEARNER__","__WORKER__";

-- Internal classification carries no source prose, target IDs or reviewer evidence.
CREATE FUNCTION "__SCHEMA__".explanation_review_source_binding(p_context jsonb,p_original jsonb) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE source record; state text:='unavailable';
BEGIN
 SELECT * INTO source FROM resolve_explanation_review_source(p_context->>'exam_id',p_context->>'set_id',p_context->>'set_version',p_context->>'item_id');
 IF NOT FOUND OR p_original IS DISTINCT FROM source.original_value THEN RETURN jsonb_build_object('state',state); END IF;
 IF EXISTS(SELECT 1 FROM explanation_review_target t WHERE (t.exam_id,t.set_id,t.set_version,t.item_id)=(p_context->>'exam_id',p_context->>'set_id',p_context->>'set_version',p_context->>'item_id')
   AND (t.content_version_id IS DISTINCT FROM source.content_version_id OR t.original_value_fingerprint IS DISTINCT FROM source.original_value_fingerprint)) THEN RETURN jsonb_build_object('state',state); END IF;
 state:=CASE WHEN EXISTS(SELECT 1 FROM explanation_review_target t WHERE (t.exam_id,t.set_id,t.set_version,t.item_id,t.content_version_id)=(p_context->>'exam_id',p_context->>'set_id',p_context->>'set_version',p_context->>'item_id',source.content_version_id)) THEN 'registered' ELSE 'unregistered' END;
 RETURN jsonb_build_object('state',state);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".explanation_review_source_binding(jsonb,jsonb) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";
CREATE OR REPLACE FUNCTION "__SCHEMA__".explanation_item_envelope(p_context jsonb,p_original jsonb,p_language text) RETURNS jsonb
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
 RETURN jsonb_build_object('kind','objective','context',p_context,'originalValue',coalesce(p_original,'null'),'representations',representations,'heads',heads,'review_source_binding',explanation_review_source_binding(p_context,p_original));
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".explanation_item_envelope(jsonb,jsonb,text) FROM PUBLIC;

-- C-03: attributable review facts; existing source and learner records are unchanged.
CREATE TABLE "__SCHEMA__".content_review_authority (
 authority_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE,
 reviewer_id text NOT NULL CHECK(reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
 reviewer_name text NOT NULL CHECK(length(btrim(reviewer_name)) BETWEEN 2 AND 200),
 exam_id text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id),
 category text NOT NULL CHECK(category IN ('educational','language','audio','exam_format')),
 language text NOT NULL, action text NOT NULL CHECK(action IN ('grant','revoke')),
 revision integer NOT NULL CHECK(revision>0), supersedes_authority_id uuid UNIQUE REFERENCES "__SCHEMA__".content_review_authority(authority_id),
 evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 500),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 3 AND 2000),
 request_payload jsonb NOT NULL, request_sha256 text NOT NULL,
 recorded_at timestamptz NOT NULL, recorded_by text NOT NULL,
 UNIQUE(reviewer_id,exam_id,category,language,revision)
);
CREATE TABLE "__SCHEMA__".content_review_decision (
 decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE,
 exam_id text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id),
 subject_kind text NOT NULL CHECK(subject_kind IN ('content','blueprint','form')),
 subject_id text NOT NULL, subject_version text NOT NULL,
 subject_sha256 text NOT NULL CHECK(subject_sha256 ~ '^[0-9a-f]{64}$'),
 content_version_id text REFERENCES "__SCHEMA__".content_version(content_version_id),
 blueprint_version text, form_id text, form_version text,
 FOREIGN KEY(exam_id,blueprint_version) REFERENCES "__SCHEMA__".exam_blueprint(exam_id,version),
 FOREIGN KEY(exam_id,form_id,form_version) REFERENCES "__SCHEMA__".exam_form(exam_id,form_id,version),
 CHECK ((subject_kind='content' AND content_version_id IS NOT NULL AND content_version_id=subject_id AND subject_version='' AND blueprint_version IS NULL AND form_id IS NULL AND form_version IS NULL)
 OR (subject_kind='blueprint' AND content_version_id IS NULL AND blueprint_version IS NOT NULL AND subject_id=exam_id AND blueprint_version=subject_version AND form_id IS NULL AND form_version IS NULL)
 OR (subject_kind='form' AND content_version_id IS NULL AND blueprint_version IS NULL AND form_id IS NOT NULL AND form_version IS NOT NULL AND form_id=subject_id AND form_version=subject_version)),
 category text NOT NULL CHECK(category IN ('educational','language','audio','exam_format')), language text NOT NULL,
 authority_id uuid NOT NULL REFERENCES "__SCHEMA__".content_review_authority(authority_id),
 decision text NOT NULL CHECK(decision IN ('approve','reject','withdraw')),
 revision integer NOT NULL CHECK(revision>0), supersedes_decision_id uuid UNIQUE REFERENCES "__SCHEMA__".content_review_decision(decision_id),
 evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 500),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 3 AND 2000),
 packet_sha256 text CHECK(packet_sha256 ~ '^[0-9a-f]{64}$'),
 request_payload jsonb NOT NULL, request_sha256 text NOT NULL,
 recorded_at timestamptz NOT NULL, recorded_by text NOT NULL,
 UNIQUE(exam_id,subject_kind,subject_id,subject_version,subject_sha256,category,language,revision)
);
CREATE TABLE "__SCHEMA__".content_review_baseline (
 exam_id text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id), subject_kind text NOT NULL,
 subject_id text NOT NULL, subject_version text NOT NULL, subject_sha256 text NOT NULL,
 legacy_review_status text NOT NULL, migration_id text NOT NULL DEFAULT '0035-content-review',
 PRIMARY KEY(exam_id,subject_kind,subject_id,subject_version)
);
INSERT INTO "__SCHEMA__".content_review_baseline(exam_id,subject_kind,subject_id,subject_version,subject_sha256,legacy_review_status)
 SELECT exam_id,'content',content_version_id,'',content_sha256,review_status FROM "__SCHEMA__".content_version
 UNION ALL SELECT exam_id,'blueprint',exam_id,version,sha256,'approved' FROM "__SCHEMA__".exam_blueprint
 UNION ALL SELECT exam_id,'form',form_id,version,sha256,'approved' FROM "__SCHEMA__".exam_form;
CREATE FUNCTION "__SCHEMA__".sealed_review_baseline() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'review_baseline_sealed' USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".sealed_review_baseline() FROM PUBLIC;
CREATE TRIGGER review_baseline_no_insert BEFORE INSERT ON "__SCHEMA__".content_review_baseline FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".sealed_review_baseline();
DO $block$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['content_review_authority','content_review_decision','content_review_baseline'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON "__SCHEMA__".%I FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON "__SCHEMA__".%I FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".content_immutable()',t||'_no_truncate',t);
 END LOOP;
END $block$;
REVOKE ALL ON "__SCHEMA__".content_review_authority,"__SCHEMA__".content_review_decision,"__SCHEMA__".content_review_baseline FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

-- Trusted target mapping. No caller chooses a required category or a backing table.
CREATE FUNCTION "__SCHEMA__".resolve_review_subject(k text,e text,i text,v text)
 RETURNS TABLE(exam_id text,subject_sha256 text,category text,language text)
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE c record; ok boolean:=false;
BEGIN
 IF k='content' AND v='' THEN
  SELECT cv.*,p.exam_language INTO c FROM "__SCHEMA__".content_version cv JOIN "__SCHEMA__".exam_package p USING(exam_id)
   WHERE cv.content_version_id=i AND (e IS NULL OR cv.exam_id=e);
  IF NOT FOUND THEN RETURN; END IF;
  IF c.kind='task' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".task_version t WHERE t.content_version_id=i AND t.exam_id=c.exam_id)
    OR EXISTS(SELECT 1 FROM "__SCHEMA__".objective_set s WHERE s.content_version_id=i AND s.exam_id=c.exam_id);
  ELSIF c.kind='rubric' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".rubric_version r WHERE r.content_version_id=i AND r.exam_id=c.exam_id);
  ELSIF c.kind='guide' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".guide g WHERE g.content_version_id=i AND g.exam_id=c.exam_id);
  ELSIF c.kind='lexicon' AND c.family='vocab' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".vocab_entry x WHERE x.content_version_id=i AND x.exam_id=c.exam_id);
  ELSIF c.kind='lexicon' AND c.family='nouns' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".noun_entry x WHERE x.content_version_id=i AND x.exam_id=c.exam_id);
  ELSIF c.kind='media' THEN ok:=EXISTS(SELECT 1 FROM "__SCHEMA__".exam_media x WHERE x.content_version_id=i AND x.exam_id=c.exam_id) AND length(c.exam_language)>0;
  END IF;
  IF NOT ok OR c.content_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  exam_id:=c.exam_id;subject_sha256:=c.content_sha256;
  category:=CASE WHEN c.kind='media' THEN 'audio' ELSE 'educational' END;
  language:=CASE WHEN c.kind='media' THEN c.exam_language ELSE '' END;RETURN NEXT;
 ELSIF k='blueprint' AND i=e AND length(v)>0 THEN
  RETURN QUERY SELECT b.exam_id,b.sha256,'exam_format'::text,''::text FROM "__SCHEMA__".exam_blueprint b WHERE b.exam_id=e AND b.version=v AND b.sha256 ~ '^[0-9a-f]{64}$';
 ELSIF k='form' AND length(v)>0 THEN
  RETURN QUERY SELECT f.exam_id,f.sha256,'exam_format'::text,''::text FROM "__SCHEMA__".exam_form f WHERE f.exam_id=e AND f.form_id=i AND f.version=v AND f.sha256 ~ '^[0-9a-f]{64}$';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".resolve_review_subject(text,text,text,text) FROM PUBLIC;

CREATE FUNCTION "__SCHEMA__".review_authority_insert() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE old record; head record; lang text; payload jsonb;
BEGIN
 IF current_user<>(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='__SCHEMA__') THEN RAISE EXCEPTION 'review_operator_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'review_read_committed_required' USING ERRCODE='25000'; END IF;
 SELECT exam_language INTO lang FROM "__SCHEMA__".exam_package WHERE exam_id=NEW.exam_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_subject_unavailable' USING ERRCODE='23503'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.exam_id,7351));
 payload:=jsonb_build_object('eventId',NEW.event_id,'reviewerId',NEW.reviewer_id,'reviewerName',NEW.reviewer_name,'examId',NEW.exam_id,
  'category',NEW.category,'language',NEW.language,'action',NEW.action,'expectedAuthorityId',NEW.supersedes_authority_id,
  'evidenceRef',NEW.evidence_ref,'evidenceSha256',NEW.evidence_sha256,'rationale',NEW.rationale);
 SELECT * INTO old FROM "__SCHEMA__".content_review_authority WHERE event_id=NEW.event_id;
 IF FOUND THEN
  IF old.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'review_event_conflict' USING ERRCODE='23505'; END IF;
  RETURN NULL;
 END IF;
 IF NOT ((NEW.category IN ('educational','exam_format') AND NEW.language='') OR (NEW.category='audio' AND NEW.language=lang)
  OR (NEW.category='language' AND NEW.language IN ('de','en','uk','ar','tr'))) THEN RAISE EXCEPTION 'review_scope_invalid' USING ERRCODE='23514'; END IF;
 SELECT * INTO head FROM "__SCHEMA__".content_review_authority WHERE reviewer_id=NEW.reviewer_id AND exam_id=NEW.exam_id AND category=NEW.category AND language=NEW.language ORDER BY revision DESC LIMIT 1;
 IF NEW.supersedes_authority_id IS DISTINCT FROM head.authority_id OR (head.authority_id IS NULL AND NEW.action='revoke') THEN RAISE EXCEPTION 'review_head_conflict' USING ERRCODE='40001'; END IF;
 NEW.revision:=coalesce(head.revision,0)+1;NEW.request_payload:=payload;
 NEW.request_sha256:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 NEW.recorded_at:=clock_timestamp();NEW.recorded_by:=session_user;RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".review_authority_insert() FROM PUBLIC;
CREATE TRIGGER content_review_authority_insert BEFORE INSERT ON "__SCHEMA__".content_review_authority FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".review_authority_insert();

CREATE FUNCTION "__SCHEMA__".review_decision_insert() RETURNS trigger
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
 SELECT * INTO subject FROM "__SCHEMA__".resolve_review_subject(NEW.subject_kind,NEW.exam_id,NEW.subject_id,NEW.subject_version);
 IF NOT FOUND OR subject.subject_sha256 IS DISTINCT FROM NEW.subject_sha256 THEN RAISE EXCEPTION 'review_subject_mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.category IS DISTINCT FROM subject.category OR NEW.language IS DISTINCT FROM subject.language THEN RAISE EXCEPTION 'review_scope_invalid' USING ERRCODE='23514'; END IF;
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
CREATE TRIGGER content_review_decision_insert BEFORE INSERT ON "__SCHEMA__".content_review_decision FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".review_decision_insert();

CREATE FUNCTION "__SCHEMA__".review_input_strings(p jsonb, fields text[]) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE field text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 FOREACH field IN ARRAY fields LOOP
  IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".review_input_strings(jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION "__SCHEMA__".append_review_authority(p jsonb) RETURNS SETOF "__SCHEMA__".content_review_authority
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 PERFORM "__SCHEMA__".review_input_strings(p,ARRAY['eventId','reviewerId','reviewerName','examId','category','language','action','evidenceRef','evidenceSha256','rationale']);
 IF p-ARRAY['eventId','reviewerId','reviewerName','examId','category','language','action','expectedAuthorityId','evidenceRef','evidenceSha256','rationale']<>'{}'::jsonb
  OR NOT p?'expectedAuthorityId' OR jsonb_typeof(p->'expectedAuthorityId') NOT IN ('string','null') THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 RETURN QUERY INSERT INTO "__SCHEMA__".content_review_authority(event_id,reviewer_id,reviewer_name,exam_id,category,language,action,supersedes_authority_id,evidence_ref,evidence_sha256,rationale)
  VALUES((p->>'eventId')::uuid,p->>'reviewerId',p->>'reviewerName',p->>'examId',p->>'category',p->>'language',p->>'action',(p->>'expectedAuthorityId')::uuid,p->>'evidenceRef',p->>'evidenceSha256',p->>'rationale') RETURNING *;
 IF NOT FOUND THEN RETURN QUERY SELECT * FROM "__SCHEMA__".content_review_authority WHERE event_id=(p->>'eventId')::uuid; END IF;
END $fn$;
CREATE FUNCTION "__SCHEMA__".append_content_review(p jsonb) RETURNS SETOF "__SCHEMA__".content_review_decision
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE s jsonb:=p->'subject'; k text;
BEGIN
 PERFORM "__SCHEMA__".review_input_strings(p,ARRAY['eventId','category','language','authorityId','decision','evidenceRef','evidenceSha256','rationale']);
 PERFORM "__SCHEMA__".review_input_strings(s,ARRAY['kind','examId','subjectId','version','sha256']);k:=s->>'kind';
 IF p-ARRAY['eventId','subject','category','language','authorityId','expectedDecisionId','decision','evidenceRef','evidenceSha256','rationale','packetSha256']<>'{}'::jsonb
  OR s-ARRAY['kind','examId','subjectId','version','sha256']<>'{}'::jsonb OR NOT p?'expectedDecisionId'
  OR jsonb_typeof(p->'expectedDecisionId') NOT IN ('string','null')
  OR (p?'packetSha256' AND jsonb_typeof(p->'packetSha256') NOT IN ('string','null')) THEN RAISE EXCEPTION 'review_input_invalid' USING ERRCODE='22023'; END IF;
 RETURN QUERY INSERT INTO "__SCHEMA__".content_review_decision(event_id,exam_id,subject_kind,subject_id,subject_version,subject_sha256,content_version_id,blueprint_version,form_id,form_version,category,language,authority_id,supersedes_decision_id,decision,evidence_ref,evidence_sha256,rationale,packet_sha256)
  VALUES((p->>'eventId')::uuid,s->>'examId',k,s->>'subjectId',s->>'version',s->>'sha256',CASE WHEN k='content' THEN s->>'subjectId' END,CASE WHEN k='blueprint' THEN s->>'version' END,CASE WHEN k='form' THEN s->>'subjectId' END,CASE WHEN k='form' THEN s->>'version' END,
  p->>'category',p->>'language',(p->>'authorityId')::uuid,(p->>'expectedDecisionId')::uuid,p->>'decision',p->>'evidenceRef',p->>'evidenceSha256',p->>'rationale',p->>'packetSha256') RETURNING *;
 IF NOT FOUND THEN RETURN QUERY SELECT * FROM "__SCHEMA__".content_review_decision WHERE event_id=(p->>'eventId')::uuid; END IF;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".append_review_authority(jsonb),"__SCHEMA__".append_content_review(jsonb) FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";

CREATE FUNCTION "__SCHEMA__".project_content_review(k text,e text,i text,v text)
 RETURNS TABLE(review_status text,review_basis text,blocked boolean,explicit_negative boolean,decision_ids uuid[])
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE subject record; head record; legacy text;
BEGIN
 review_status:='unavailable';review_basis:='none';blocked:=true;explicit_negative:=false;decision_ids:=ARRAY[]::uuid[];
 SELECT * INTO subject FROM "__SCHEMA__".resolve_review_subject(k,e,i,v);
 IF NOT FOUND THEN RETURN NEXT;RETURN;END IF;
 SELECT * INTO head FROM "__SCHEMA__".content_review_decision WHERE exam_id=subject.exam_id AND subject_kind=k AND subject_id=i AND subject_version=v AND subject_sha256=subject.subject_sha256 AND category=subject.category AND language=subject.language ORDER BY revision DESC LIMIT 1;
 IF FOUND THEN
  review_status:=CASE head.decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END;
  review_basis:='named_decision';decision_ids:=ARRAY[head.decision_id];
 ELSE
  SELECT legacy_review_status INTO legacy FROM "__SCHEMA__".content_review_baseline WHERE exam_id=subject.exam_id AND subject_kind=k AND subject_id=i AND subject_version=v AND subject_sha256=subject.subject_sha256;
  IF FOUND THEN
   review_status:=CASE WHEN legacy IN ('approved','unreviewed','rejected','withdrawn') THEN legacy ELSE 'unavailable' END;review_basis:='legacy_unattributed';
  ELSE review_status:='unreviewed'; END IF;
 END IF;
 explicit_negative:=review_status IN ('rejected','withdrawn');blocked:=explicit_negative OR review_status='unavailable';RETURN NEXT;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".project_content_review(text,text,text,text) FROM PUBLIC;
CREATE FUNCTION "__SCHEMA__".effective_content_review(p_content_version_id text)
 RETURNS TABLE(review_status text,review_basis text,blocked boolean,explicit_negative boolean,decision_ids uuid[])
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN RETURN QUERY SELECT * FROM "__SCHEMA__".project_content_review('content',NULL,p_content_version_id,'');END $fn$;
CREATE FUNCTION "__SCHEMA__".effective_format_review(p_exam_id text,p_subject_kind text,p_subject_id text,p_version text)
 RETURNS TABLE(review_status text,review_basis text,blocked boolean,explicit_negative boolean,decision_ids uuid[])
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF p_subject_kind IS NULL OR p_subject_kind NOT IN ('blueprint','form') OR p_exam_id IS NULL THEN
  RETURN QUERY SELECT 'unavailable'::text,'none'::text,true,false,ARRAY[]::uuid[];RETURN;
 END IF;
 RETURN QUERY SELECT * FROM "__SCHEMA__".project_content_review(p_subject_kind,p_exam_id,p_subject_id,p_version);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".effective_content_review(text),"__SCHEMA__".effective_format_review(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".effective_content_review(text),"__SCHEMA__".effective_format_review(text,text,text,text) TO "__LEARNER__","__WORKER__";

-- Private invocation facts; learner charging remains the existing usage_ledger.
ALTER TABLE "__SCHEMA__".jobs ADD CONSTRAINT provider_job_identity UNIQUE(id,owner_id,exam_id,submission_id);
CREATE TABLE "__SCHEMA__".provider_attempt(
 attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,exam_id text NOT NULL,job_id uuid NOT NULL,submission_id uuid NOT NULL,
 claim_number integer NOT NULL CHECK(claim_number>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),schema_version integer NOT NULL CHECK(schema_version=1),
 adapter_id text NOT NULL,adapter_version text NOT NULL,provider_id text NOT NULL,operation text NOT NULL,transport_mode text NOT NULL,
 requested_model text,prompt_version text NOT NULL,task_id text NOT NULL,task_version text NOT NULL,rubric_id text NOT NULL,rubric_version text NOT NULL,
 pricing_card_id text,pricing_card jsonb,pricing_sha256 text,identity_sha256 text NOT NULL,
 UNIQUE(job_id,claim_number),UNIQUE(attempt_id,owner_id,exam_id,job_id,submission_id,claim_number),
 FOREIGN KEY(job_id,owner_id,exam_id,submission_id) REFERENCES "__SCHEMA__".jobs(id,owner_id,exam_id,submission_id),
 FOREIGN KEY(submission_id,owner_id) REFERENCES "__SCHEMA__".submissions(id,owner_id)
);
CREATE TABLE "__SCHEMA__".provider_attempt_observation(
 event_id uuid PRIMARY KEY,attempt_id uuid NOT NULL,owner_id text NOT NULL,exam_id text NOT NULL,job_id uuid NOT NULL,submission_id uuid NOT NULL,claim_number integer NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000000),previous_event_id uuid,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_sha256 text NOT NULL,
 transport_status text NOT NULL,disposition text NOT NULL,failure_code text,model_reported text,usage_basis text NOT NULL,receipt_issue text,
 input_tokens bigint,output_tokens bigint,cached_input_tokens bigint,reasoning_output_tokens bigint,receipt_captured boolean NOT NULL,
 elapsed_ms integer,elapsed_issue text,cost_status text NOT NULL,cost_reason text,currency text,estimated_amount text,pricing_sha256 text,
 UNIQUE(attempt_id,revision),UNIQUE(event_id,attempt_id),
 FOREIGN KEY(attempt_id,owner_id,exam_id,job_id,submission_id,claim_number) REFERENCES "__SCHEMA__".provider_attempt(attempt_id,owner_id,exam_id,job_id,submission_id,claim_number),
 FOREIGN KEY(previous_event_id,attempt_id) REFERENCES "__SCHEMA__".provider_attempt_observation(event_id,attempt_id),
 CHECK((revision=1)=(previous_event_id IS NULL))
);
CREATE INDEX provider_attempt_created ON "__SCHEMA__".provider_attempt(created_at,attempt_id);
CREATE INDEX provider_attempt_owner ON "__SCHEMA__".provider_attempt(owner_id);
CREATE INDEX provider_observation_owner ON "__SCHEMA__".provider_attempt_observation(owner_id);
REVOKE ALL ON "__SCHEMA__".provider_attempt,"__SCHEMA__".provider_attempt_observation FROM PUBLIC,"__AUTH__","__LEARNER__","__WORKER__","__DELETION__","__PAYMENTS__";
GRANT SELECT ON "__SCHEMA__".provider_attempt,"__SCHEMA__".provider_attempt_observation TO "__WORKER__";
GRANT SELECT,DELETE ON "__SCHEMA__".provider_attempt,"__SCHEMA__".provider_attempt_observation TO "__DELETION__";
ALTER TABLE "__SCHEMA__".provider_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".provider_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".provider_attempt_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".provider_attempt_observation FORCE ROW LEVEL SECURITY;
DO $block$
DECLARE t text; own text:=(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='__SCHEMA__');
BEGIN
 FOREACH t IN ARRAY ARRAY['provider_attempt','provider_attempt_observation'] LOOP
  EXECUTE format('CREATE POLICY provider_worker_read ON "__SCHEMA__".%I FOR SELECT TO "__WORKER__" USING(true)',t);
  EXECUTE format('CREATE POLICY provider_deletion ON "__SCHEMA__".%I TO "__DELETION__" USING(owner_id=nullif(current_setting(''hatoove.owner_id'',true),''''))',t);
  EXECUTE format('CREATE POLICY provider_function_owner ON "__SCHEMA__".%I TO %I USING(true) WITH CHECK(true)',t,own);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs','submissions','attempts','assessments','usage_ledger'] LOOP
  EXECUTE format('CREATE POLICY provider_function_read ON "__SCHEMA__".%I FOR SELECT TO %I USING(true)',t,own);
 END LOOP;
 EXECUTE format('CREATE POLICY provider_function_job_lock ON "__SCHEMA__".jobs FOR UPDATE TO %I USING(true) WITH CHECK(true)',own);
END $block$;

CREATE FUNCTION "__SCHEMA__".provider_require_role(expected text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>expected THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='42501'; END IF;
END $fn$;
CREATE FUNCTION "__SCHEMA__".provider_json_bytes(p jsonb,keys text[]) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
 SELECT '{'||string_agg(to_json(k)::text||':'||coalesce((p->k)::text,'null'),',' ORDER BY n)||'}' FROM unnest(keys) WITH ORDINALITY a(k,n)
$fn$;
CREATE FUNCTION "__SCHEMA__".provider_identity(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE aid text:=p->>'adapterId'; cid text:=p->>'pricingCardId'; card jsonb; card_bytes text; identity jsonb; bytes text; local_mode boolean;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR aid NOT IN ('local-telc-stub-v1','local-dtz-stub-v1','synthetic-grader-v1') OR aid IS NULL
  OR (cid IS NOT NULL AND cid NOT IN ('synthetic-usd-v1','synthetic-eur-v1')) THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='22023'; END IF;
 local_mode:=aid<>'synthetic-grader-v1';
 IF local_mode AND cid IS NOT NULL THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='22023'; END IF;
 IF cid IS NOT NULL THEN
  card_bytes:='{"schemaVersion":1,"cardId":'||to_json(cid)::text||',"currency":'||to_json(CASE cid WHEN 'synthetic-usd-v1' THEN 'USD' ELSE 'EUR' END)::text||',"modelIds":["fixture-model-a"],"unit":1000000,"inputRate":"2","cachedInputRate":"0.5","outputRate":"4","reasoningOutputRate":"4"}';card:=card_bytes::jsonb;
 END IF;
 identity:=jsonb_build_object('schemaVersion',1,'adapterId',aid,'adapterVersion',aid,'providerId',CASE WHEN local_mode THEN 'none' ELSE 'synthetic' END,
  'operation','writing_assessment','transportMode',CASE WHEN local_mode THEN 'local_stub' ELSE 'synthetic_fixture' END,'requestedModel',CASE WHEN local_mode THEN NULL ELSE 'fixture-model-a' END,
  'promptVersion',CASE aid WHEN 'local-telc-stub-v1' THEN 'stub-grader-v2' WHEN 'local-dtz-stub-v1' THEN 'dtz-simulation-v1' ELSE 'synthetic-prompt-v1' END,
  'pricingCardId',cid,'pricingCard',card,'pricingSha256',CASE WHEN card IS NULL THEN NULL ELSE encode(sha256(convert_to(card_bytes,'UTF8')),'hex') END);
 IF p IS DISTINCT FROM identity THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='22023'; END IF;
 bytes:=provider_json_bytes(identity,ARRAY['schemaVersion','adapterId','adapterVersion','providerId','operation','transportMode','requestedModel','promptVersion','pricingCardId']);
 bytes:=left(bytes,-1)||',"pricingCard":'||coalesce(card_bytes,'null')||',"pricingSha256":'||coalesce((identity->'pricingSha256')::text,'null')||'}';
 RETURN identity||jsonb_build_object('identitySha256',encode(sha256(convert_to(bytes,'UTF8')),'hex'));
END $fn$;
CREATE FUNCTION "__SCHEMA__".provider_observation_value(i "__SCHEMA__".provider_attempt,p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE r jsonb:=p->'receipt'; k text; value numeric; it bigint; ot bigint; ct bigint; rt bigint; issue text:=r->>'receiptIssue'; basis text:=r->>'usageBasis'; reason text; amount numeric; out_amount text; cost text:='unknown'; currency text:=i.pricing_card->>'currency';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['transportStatus','disposition','failureCode','receipt','receiptCaptured','elapsedMs','elapsedIssue']<>'{}'
  OR NOT p ?& ARRAY['transportStatus','disposition','failureCode','receipt','receiptCaptured','elapsedMs','elapsedIssue']
  OR p->>'transportStatus' IS NULL OR p->>'transportStatus' NOT IN ('response','definite_not_sent','uncertain')
  OR p->>'disposition' IS NULL OR p->>'disposition' NOT IN ('pending','accepted','rejected','stale','failed','skipped')
  OR jsonb_typeof(p->'receiptCaptured') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['modelReported','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','usageBasis','receiptIssue']<>'{}'
  OR NOT r ?& ARRAY['modelReported','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','usageBasis','receiptIssue']
  OR basis IS NULL OR basis NOT IN ('reported','missing','not_applicable','unsupported')
  OR (issue IS NOT NULL AND issue NOT IN ('invalid_receipt','conflicting_receipt','unrecognised_model'))
  OR (r->>'modelReported' IS NOT NULL AND (jsonb_typeof(r->'modelReported')<>'string' OR (i.transport_mode='local_stub' AND r->>'modelReported'<>i.prompt_version) OR (i.transport_mode='synthetic_fixture' AND r->>'modelReported' NOT IN ('fixture-model-a','fixture-model-b'))))
  OR (basis='not_applicable' AND (i.transport_mode<>'local_stub' OR r->>'modelReported' IS DISTINCT FROM i.prompt_version))
  OR (issue='unrecognised_model' AND r->>'modelReported' IS NOT NULL) THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'] LOOP
  IF r->k<>'null'::jsonb THEN
   IF jsonb_typeof(r->k)<>'number' THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
   value:=(r->>k)::numeric;
   IF value<>trunc(value) OR value<0 OR value>1000000000000 OR basis<>'reported' THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
  END IF;
 END LOOP;
 it:=(r->>'inputTokens')::bigint;ot:=(r->>'outputTokens')::bigint;ct:=(r->>'cachedInputTokens')::bigint;rt:=(r->>'reasoningOutputTokens')::bigint;
 IF (ct IS NOT NULL AND (it IS NULL OR ct>it)) OR (rt IS NOT NULL AND (ot IS NULL OR rt>ot)) THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 IF p->'elapsedMs'='null'::jsonb THEN
  IF p->>'elapsedIssue' IS NULL OR p->>'elapsedIssue' NOT IN ('unavailable','out_of_range') THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p->'elapsedMs')<>'number' OR (p->>'elapsedMs')::numeric<>trunc((p->>'elapsedMs')::numeric) OR (p->>'elapsedMs')::numeric NOT BETWEEN 0 AND 86400000 OR p->'elapsedIssue'<>'null'::jsonb THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 END IF;
 IF NOT (p->>'receiptCaptured')::boolean AND (r IS DISTINCT FROM '{"modelReported":null,"inputTokens":null,"outputTokens":null,"cachedInputTokens":null,"reasoningOutputTokens":null,"usageBasis":"missing","receiptIssue":null}'::jsonb OR p->'elapsedMs'<>'null'::jsonb)
  OR (p->>'transportStatus'='response' AND NOT (p->>'receiptCaptured')::boolean)
  OR (p->>'transportStatus'='definite_not_sent' AND (p->>'receiptCaptured')::boolean)
  OR (p->>'disposition' IN ('pending','accepted') AND p->'failureCode'<>'null'::jsonb)
  OR (p->>'disposition'='accepted' AND p->>'transportStatus'<>'response')
  OR (p->>'disposition'='rejected' AND coalesce(p->>'failureCode','') NOT IN ('invalid_assessment','content_unavailable'))
  OR (p->>'disposition'='failed' AND coalesce(p->>'failureCode','') NOT IN ('grader_error','retry_exhausted'))
  OR (p->>'disposition'='stale' AND coalesce(p->>'failureCode','') NOT IN ('lease_reclaimed','claim_stale'))
  OR (p->>'disposition'='skipped' AND coalesce(p->>'failureCode','') NOT IN ('attempt_deleted','dispatch_not_started'))
 THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 IF p->>'transportStatus'<>'response' THEN reason:='uncertain_transport';
 ELSIF issue IN ('invalid_receipt','conflicting_receipt') THEN reason:='invalid_receipt';
 ELSIF i.transport_mode='local_stub' AND basis='not_applicable' THEN cost:='not_applicable';currency:=NULL;
 ELSIF basis='unsupported' THEN reason:='unsupported_usage';
 ELSIF basis<>'reported' THEN reason:='missing_usage';
 ELSIF i.pricing_card IS NULL THEN reason:='missing_card';
 ELSIF r->>'modelReported' IS NULL OR issue='unrecognised_model' THEN reason:='model_unknown';
 ELSIF r->>'modelReported'<>'fixture-model-a' THEN reason:='model_mismatch';
 ELSIF it IS NULL OR ot IS NULL OR ct IS NULL THEN reason:='missing_billable_dimension';
 ELSE
  amount:=((it-ct)::numeric*2+ct::numeric*0.5+ot::numeric*4)/1000000;
  out_amount:=CASE WHEN amount=0 THEN '0' WHEN position('.' IN amount::text)>0 THEN rtrim(rtrim(amount::text,'0'),'.') ELSE amount::text END;cost:='estimated';
 END IF;
 RETURN p||jsonb_build_object('costStatus',cost,'costReason',reason,'currency',currency,'estimatedAmount',out_amount,'pricingSha256',CASE WHEN cost='not_applicable' THEN NULL ELSE i.pricing_sha256 END);
END $fn$;

CREATE FUNCTION "__SCHEMA__".guard_provider_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE ident jsonb; bound record;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN
  IF current_user<>'__DELETION__' OR OLD.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'') THEN RAISE EXCEPTION 'provider_parent_deleted' USING ERRCODE='42501'; END IF;RETURN OLD;
 END IF;
 ident:=provider_identity(jsonb_build_object('schemaVersion',NEW.schema_version,'adapterId',NEW.adapter_id,'adapterVersion',NEW.adapter_version,'providerId',NEW.provider_id,'operation',NEW.operation,'transportMode',NEW.transport_mode,'requestedModel',NEW.requested_model,'promptVersion',NEW.prompt_version,'pricingCardId',NEW.pricing_card_id,'pricingCard',NEW.pricing_card,'pricingSha256',NEW.pricing_sha256));
 IF NEW.identity_sha256<>ident->>'identitySha256' THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='23514'; END IF;
 SELECT a.task_id,s.task_version,a.rubric_id,s.rubric_version INTO bound FROM submissions s JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id WHERE s.id=NEW.submission_id AND s.owner_id=NEW.owner_id AND a.exam_id=NEW.exam_id;
 IF NOT FOUND OR jsonb_build_array(NEW.task_id,NEW.task_version,NEW.rubric_id,NEW.rubric_version) IS DISTINCT FROM jsonb_build_array(bound.task_id,bound.task_version,bound.rubric_id,bound.rubric_version) THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION "__SCHEMA__".guard_provider_observation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE prior "__SCHEMA__".provider_attempt_observation; i "__SCHEMA__".provider_attempt; p jsonb; v jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN
  IF current_user<>'__DELETION__' OR OLD.owner_id IS DISTINCT FROM nullif(current_setting('hatoove.owner_id',true),'') THEN RAISE EXCEPTION 'provider_parent_deleted' USING ERRCODE='42501'; END IF;RETURN OLD;
 END IF;
 SELECT * INTO i FROM provider_attempt WHERE attempt_id=NEW.attempt_id;
 p:=jsonb_build_object('transportStatus',NEW.transport_status,'disposition',NEW.disposition,'failureCode',NEW.failure_code,'receiptCaptured',NEW.receipt_captured,'elapsedMs',NEW.elapsed_ms,'elapsedIssue',NEW.elapsed_issue,
  'receipt',jsonb_build_object('modelReported',NEW.model_reported,'inputTokens',NEW.input_tokens,'outputTokens',NEW.output_tokens,'cachedInputTokens',NEW.cached_input_tokens,'reasoningOutputTokens',NEW.reasoning_output_tokens,'usageBasis',NEW.usage_basis,'receiptIssue',NEW.receipt_issue));
 v:=provider_observation_value(i,p);
 IF jsonb_build_array(NEW.cost_status,NEW.cost_reason,NEW.currency,NEW.estimated_amount,NEW.pricing_sha256) IS DISTINCT FROM jsonb_build_array(v->>'costStatus',v->>'costReason',v->>'currency',v->>'estimatedAmount',v->>'pricingSha256') THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.revision>1 THEN
  SELECT * INTO prior FROM provider_attempt_observation WHERE event_id=NEW.previous_event_id AND attempt_id=NEW.attempt_id AND revision=NEW.revision-1;
  IF NOT FOUND OR (prior.transport_status='response' AND NEW.transport_status<>'response') OR (prior.transport_status='definite_not_sent' AND NEW.transport_status<>'definite_not_sent') OR (prior.transport_status='uncertain' AND NEW.transport_status='definite_not_sent')
   OR (prior.disposition<>'pending' AND (NEW.disposition<>prior.disposition OR NEW.failure_code IS DISTINCT FROM prior.failure_code))
   OR (prior.receipt_captured AND jsonb_build_array(NEW.receipt_captured,NEW.model_reported,NEW.usage_basis,NEW.receipt_issue,NEW.input_tokens,NEW.output_tokens,NEW.cached_input_tokens,NEW.reasoning_output_tokens,NEW.elapsed_ms,NEW.elapsed_issue,NEW.transport_status)
    IS DISTINCT FROM jsonb_build_array(prior.receipt_captured,prior.model_reported,prior.usage_basis,prior.receipt_issue,prior.input_tokens,prior.output_tokens,prior.cached_input_tokens,prior.reasoning_output_tokens,prior.elapsed_ms,prior.elapsed_issue,prior.transport_status))
  THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $fn$;
CREATE FUNCTION "__SCHEMA__".guard_provider_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='23514';END $fn$;
CREATE TRIGGER provider_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON "__SCHEMA__".provider_attempt FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_provider_attempt();
CREATE TRIGGER provider_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON "__SCHEMA__".provider_attempt_observation FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_provider_observation();
CREATE TRIGGER provider_attempt_truncate BEFORE TRUNCATE ON "__SCHEMA__".provider_attempt FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_provider_truncate();
CREATE TRIGGER provider_observation_truncate BEFORE TRUNCATE ON "__SCHEMA__".provider_attempt_observation FOR EACH STATEMENT EXECUTE FUNCTION "__SCHEMA__".guard_provider_truncate();

CREATE FUNCTION "__SCHEMA__".begin_provider_attempt(p_job_id uuid,p_lease_token uuid,p_identity jsonb) RETURNS TABLE(attempt_id uuid,created boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE j record; bound record; i jsonb; prior "__SCHEMA__".provider_attempt; aid uuid;
BEGIN
 PERFORM provider_require_role('__WORKER__');
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'provider_intent_failed' USING ERRCODE='25000'; END IF;
 i:=provider_identity(p_identity);SELECT owner_id,exam_id INTO j FROM jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'provider_intent_failed' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.owner_id,7352));PERFORM pg_advisory_xact_lock(hashtextextended(j.exam_id,7351));
 SELECT * INTO j FROM jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until<=clock_timestamp() OR j.lease_until IS NULL OR j.tries<1 THEN RAISE EXCEPTION 'provider_intent_failed' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM provider_attempt a WHERE a.job_id=j.id AND a.claim_number=j.tries FOR UPDATE;
 IF FOUND THEN
  IF prior.identity_sha256<>i->>'identitySha256' THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT prior.attempt_id,false;RETURN;
 END IF;
 SELECT a.task_id,s.task_version,a.rubric_id,s.rubric_version FROM submissions s JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id WHERE s.id=j.submission_id AND s.owner_id=j.owner_id AND a.exam_id=j.exam_id AND a.deleted_at IS NULL INTO bound;
 IF NOT FOUND THEN RAISE EXCEPTION 'provider_parent_deleted' USING ERRCODE='P0001'; END IF;
 INSERT INTO provider_attempt(owner_id,exam_id,job_id,submission_id,claim_number,schema_version,adapter_id,adapter_version,provider_id,operation,transport_mode,requested_model,prompt_version,task_id,task_version,rubric_id,rubric_version,pricing_card_id,pricing_card,pricing_sha256,identity_sha256)
 VALUES(j.owner_id,j.exam_id,j.id,j.submission_id,j.tries,1,i->>'adapterId',i->>'adapterVersion',i->>'providerId',i->>'operation',i->>'transportMode',i->>'requestedModel',i->>'promptVersion',bound.task_id,bound.task_version,bound.rubric_id,bound.rubric_version,i->>'pricingCardId',nullif(i->'pricingCard','null'),i->>'pricingSha256',i->>'identitySha256') RETURNING provider_attempt.attempt_id INTO aid;
 RETURN QUERY SELECT aid,true;
END $fn$;
CREATE FUNCTION "__SCHEMA__".append_provider_observation(p_attempt_id uuid,p_event_id uuid,p_expected_revision integer,p_observation jsonb,p_lease_token uuid DEFAULT NULL)
 RETURNS TABLE(status text,event_id uuid,revision integer,replay boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE i "__SCHEMA__".provider_attempt; j record; prior "__SCHEMA__".provider_attempt_observation; event "__SCHEMA__".provider_attempt_observation; v jsonb; r jsonb; bytes text; fingerprint text; next_revision integer;
BEGIN
 PERFORM provider_require_role('__WORKER__');
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'provider_observation_failed' USING ERRCODE='25000'; END IF;
 SELECT * INTO i FROM provider_attempt a WHERE a.attempt_id=p_attempt_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'deleted'::text,NULL::uuid,NULL::integer,false;RETURN;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.owner_id,7352));PERFORM pg_advisory_xact_lock(hashtextextended(i.exam_id,7351));
 SELECT * INTO j FROM jobs WHERE id=i.job_id FOR UPDATE;
 SELECT * INTO i FROM provider_attempt a WHERE a.attempt_id=p_attempt_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'deleted'::text,NULL::uuid,NULL::integer,false;RETURN;END IF;
 IF p_event_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 999999 THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023';END IF;
 v:=provider_observation_value(i,p_observation);r:=p_observation->'receipt';
 bytes:='{"attemptId":'||to_json(p_attempt_id)::text||',"eventId":'||to_json(p_event_id)::text||',"expectedRevision":'||p_expected_revision::text||',"observation":';
 bytes:=bytes||left(provider_json_bytes(p_observation,ARRAY['transportStatus','disposition','failureCode']),-1)||',"receipt":'||provider_json_bytes(r,ARRAY['modelReported','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','usageBasis','receiptIssue'])||','||substring(provider_json_bytes(p_observation,ARRAY['receiptCaptured','elapsedMs','elapsedIssue']) FROM 2)||'}';
 fingerprint:=encode(sha256(convert_to(bytes,'UTF8')),'hex');
 SELECT * INTO event FROM provider_attempt_observation o WHERE o.event_id=p_event_id;
 IF FOUND THEN
  IF event.attempt_id<>p_attempt_id OR event.event_sha256<>fingerprint THEN RAISE EXCEPTION 'provider_event_conflict' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT 'recorded'::text,event.event_id,event.revision,true;RETURN;
 END IF;
 SELECT * INTO prior FROM provider_attempt_observation o WHERE o.attempt_id=p_attempt_id ORDER BY o.revision DESC LIMIT 1;
 IF coalesce(prior.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'provider_head_conflict' USING ERRCODE='P0001';END IF;
 IF p_observation->>'disposition'='accepted' AND (j.status<>'running' OR j.lease_token IS DISTINCT FROM p_lease_token OR j.tries<>i.claim_number OR (prior.disposition IS NOT NULL AND prior.disposition<>'pending')) THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='P0001';END IF;
 next_revision:=p_expected_revision+1;
 INSERT INTO provider_attempt_observation(event_id,attempt_id,owner_id,exam_id,job_id,submission_id,claim_number,revision,previous_event_id,event_sha256,transport_status,disposition,failure_code,model_reported,usage_basis,receipt_issue,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens,receipt_captured,elapsed_ms,elapsed_issue,cost_status,cost_reason,currency,estimated_amount,pricing_sha256)
 VALUES(p_event_id,i.attempt_id,i.owner_id,i.exam_id,i.job_id,i.submission_id,i.claim_number,next_revision,prior.event_id,fingerprint,p_observation->>'transportStatus',p_observation->>'disposition',p_observation->>'failureCode',r->>'modelReported',r->>'usageBasis',r->>'receiptIssue',(r->>'inputTokens')::bigint,(r->>'outputTokens')::bigint,(r->>'cachedInputTokens')::bigint,(r->>'reasoningOutputTokens')::bigint,(p_observation->>'receiptCaptured')::boolean,(p_observation->>'elapsedMs')::integer,p_observation->>'elapsedIssue',v->>'costStatus',v->>'costReason',v->>'currency',v->>'estimatedAmount',v->>'pricingSha256');
 RETURN QUERY SELECT 'recorded'::text,p_event_id,next_revision,false;
END $fn$;
CREATE FUNCTION "__SCHEMA__".guard_provider_accepted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
BEGIN
 IF NEW.disposition='accepted' AND NOT EXISTS(SELECT 1 FROM jobs j JOIN assessments a ON a.submission_id=j.submission_id AND a.owner_id=j.owner_id JOIN usage_ledger u ON u.submission_id=j.submission_id AND u.owner_id=j.owner_id
  WHERE j.id=NEW.job_id AND j.owner_id=NEW.owner_id AND j.exam_id=NEW.exam_id AND j.submission_id=NEW.submission_id AND j.tries=NEW.claim_number AND j.status='succeeded' AND u.units=1)
 THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='23514';END IF;RETURN NEW;
END $fn$;
CREATE CONSTRAINT TRIGGER provider_observation_accepted AFTER INSERT ON "__SCHEMA__".provider_attempt_observation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_provider_accepted();
CREATE FUNCTION "__SCHEMA__".export_owned_provider_attempts() RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE who text:=nullif(current_setting('hatoove.owner_id',true),'');
BEGIN
 PERFORM provider_require_role('__LEARNER__');
 IF current_setting('transaction_isolation')<>'repeatable read' OR current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'provider_report_invalid' USING ERRCODE='25000';END IF;
 RETURN QUERY SELECT jsonb_build_object('attempt_id',a.attempt_id,'submission_id',a.submission_id,'exam_id',a.exam_id,'claim_number',a.claim_number,'created_at',a.created_at,'transport_mode',a.transport_mode,'provider_id',a.provider_id,'requested_model',a.requested_model,
  'observations',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',o.revision,'recorded_at',o.recorded_at,'transport_status',o.transport_status,'disposition',o.disposition,'failure_code',o.failure_code,'model_reported',o.model_reported,'usage_basis',o.usage_basis,'receipt_issue',o.receipt_issue,'input_tokens',o.input_tokens,'output_tokens',o.output_tokens,'cached_input_tokens',o.cached_input_tokens,'reasoning_output_tokens',o.reasoning_output_tokens,'elapsed_ms',o.elapsed_ms,'elapsed_issue',o.elapsed_issue,'cost_status',o.cost_status,'cost_reason',o.cost_reason,'currency',o.currency,'estimated_amount',o.estimated_amount) ORDER BY o.revision) FROM provider_attempt_observation o WHERE o.attempt_id=a.attempt_id AND o.owner_id=who),'[]'))
 FROM provider_attempt a WHERE a.owner_id=who ORDER BY a.created_at,a.attempt_id;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".provider_require_role(text),"__SCHEMA__".provider_json_bytes(jsonb,text[]),"__SCHEMA__".provider_identity(jsonb),"__SCHEMA__".provider_observation_value("__SCHEMA__".provider_attempt,jsonb),"__SCHEMA__".guard_provider_attempt(),"__SCHEMA__".guard_provider_observation(),"__SCHEMA__".guard_provider_truncate(),"__SCHEMA__".guard_provider_accepted(),"__SCHEMA__".begin_provider_attempt(uuid,uuid,jsonb),"__SCHEMA__".append_provider_observation(uuid,uuid,integer,jsonb,uuid),"__SCHEMA__".export_owned_provider_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".begin_provider_attempt(uuid,uuid,jsonb),"__SCHEMA__".append_provider_observation(uuid,uuid,integer,jsonb,uuid) TO "__WORKER__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".export_owned_provider_attempts() TO "__LEARNER__";

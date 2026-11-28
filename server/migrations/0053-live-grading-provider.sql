-- Add real provider identities without rewriting historical attempt records.
-- Peak prices are conservative estimates, not invoice amounts (2026-11-28).
ALTER FUNCTION "__SCHEMA__".provider_identity(jsonb) RENAME TO provider_identity_v1;
CREATE FUNCTION "__SCHEMA__".provider_identity(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE card_bytes text; card jsonb; ident jsonb; bytes text;
BEGIN
 IF p->>'adapterId' IS DISTINCT FROM 'deepseek-writing-v2' THEN RETURN provider_identity_v1(p); END IF;
 card_bytes:='{"schemaVersion":1,"cardId":"deepseek-flash-peak-20261128","currency":"USD","modelIds":["deepseek-flash","DeepSeek-V4.1-Flash-1017"],"unit":1000000,"inputRate":"0.3","cachedInputRate":"0.006","outputRate":"1.2","reasoningOutputRate":"1.2"}';
 card:=card_bytes::jsonb;
 ident:=jsonb_build_object('schemaVersion',1,'adapterId','deepseek-writing-v2','adapterVersion','deepseek-writing-v2','providerId','deepseek',
  'operation','writing_assessment','transportMode','https','requestedModel','deepseek-flash','promptVersion','deepseek-writing-v2',
  'pricingCardId','deepseek-flash-peak-20261128','pricingCard',card,'pricingSha256',encode(sha256(convert_to(card_bytes,'UTF8')),'hex'));
 IF p IS DISTINCT FROM ident THEN RAISE EXCEPTION 'provider_identity_invalid' USING ERRCODE='22023'; END IF;
 bytes:=provider_json_bytes(ident,ARRAY['schemaVersion','adapterId','adapterVersion','providerId','operation','transportMode','requestedModel','promptVersion','pricingCardId']);
 bytes:=left(bytes,-1)||',"pricingCard":'||card_bytes||',"pricingSha256":'||(ident->'pricingSha256')::text||'}';
 RETURN ident||jsonb_build_object('identitySha256',encode(sha256(convert_to(bytes,'UTF8')),'hex'));
END $fn$;

ALTER FUNCTION "__SCHEMA__".provider_observation_value("__SCHEMA__".provider_attempt,jsonb) RENAME TO provider_observation_value_v1;
CREATE FUNCTION "__SCHEMA__".provider_observation_value(i "__SCHEMA__".provider_attempt,p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE v jsonb; r jsonb; reason text; amount numeric; amount_text text;
BEGIN
 v:=provider_observation_value_v1(i,p);
 IF i.adapter_id<>'deepseek-writing-v2' THEN RETURN v; END IF;
 r:=v->'receipt';
 IF r->>'modelReported' IS NOT NULL AND r->>'modelReported' NOT IN ('deepseek-flash','DeepSeek-V4.1-Flash-1017') THEN RAISE EXCEPTION 'provider_observation_invalid' USING ERRCODE='22023'; END IF;
 IF v->>'transportStatus'<>'response' THEN reason:='uncertain_transport';
 ELSIF r->>'receiptIssue' IN ('invalid_receipt','conflicting_receipt') THEN reason:='invalid_receipt';
 ELSIF r->>'usageBasis'='unsupported' THEN reason:='unsupported_usage';
 ELSIF r->>'usageBasis'<>'reported' THEN reason:='missing_usage';
 ELSIF r->>'modelReported' IS NULL OR r->>'receiptIssue'='unrecognised_model' THEN reason:='model_unknown';
 ELSIF r->>'inputTokens' IS NULL OR r->>'outputTokens' IS NULL OR r->>'cachedInputTokens' IS NULL THEN reason:='missing_billable_dimension';
 ELSE
  amount:=(((r->>'inputTokens')::numeric-(r->>'cachedInputTokens')::numeric)*0.3+(r->>'cachedInputTokens')::numeric*0.006+(r->>'outputTokens')::numeric*1.2)/1000000;
  amount_text:=CASE WHEN amount=0 THEN '0' ELSE rtrim(rtrim(amount::text,'0'),'.') END;
 END IF;
 RETURN v||jsonb_build_object('costStatus',CASE WHEN reason IS NULL THEN 'estimated' ELSE 'unknown' END,'costReason',reason,'currency','USD','estimatedAmount',amount_text,'pricingSha256',i.pricing_sha256);
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".provider_identity(jsonb),"__SCHEMA__".provider_observation_value("__SCHEMA__".provider_attempt,jsonb) FROM PUBLIC;

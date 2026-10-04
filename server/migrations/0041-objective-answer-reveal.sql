-- REDESIGN-01 slice A: show the correct option AFTER the learner has answered (Ron, 4 October 2026).
--
-- The key stays unreadable by every runtime role (0021). This function reveals ONE item's expected answer,
-- and only to an owner who already has an evidence row for that exact (set, version, item). Evidence is
-- written by `mark_objective_item`'s caller after a practice answer, and by `finalise_mock_run` only when a
-- mock run is finalised, so a key is never available before the learner's own answer is recorded and a
-- mock run in progress reveals nothing. Item-serving payloads are unchanged.
CREATE OR REPLACE FUNCTION "__SCHEMA__".reveal_objective_answer(p_set_id text,p_version text,p_item_id text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE bound_owner text; expected jsonb;
BEGIN
 bound_owner:=nullif(current_setting('hatoove.owner_id',true),'');
 IF bound_owner IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "__SCHEMA__".item_evidence e
   WHERE e.owner_id=bound_owner AND e.set_id=p_set_id AND e.version=p_version AND e.item_id=p_item_id) THEN
  RETURN NULL;
 END IF;
 SELECT k.answers->p_item_id INTO expected FROM "__SCHEMA__".objective_key k WHERE k.set_id=p_set_id AND k.version=p_version;
 RETURN expected;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".reveal_objective_answer(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".reveal_objective_answer(text,text,text) TO "__LEARNER__";

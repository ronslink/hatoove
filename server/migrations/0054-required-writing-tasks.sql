-- Keep existing attempts and immutable legacy bindings; add independently saved required tasks.
ALTER TABLE "__SCHEMA__".mock_writing ADD COLUMN binding_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE "__SCHEMA__".mock_writing DROP CONSTRAINT mock_writing_pkey;
ALTER TABLE "__SCHEMA__".mock_writing ADD PRIMARY KEY(run_id,binding_id);
ALTER TABLE "__SCHEMA__".mock_writing DROP CONSTRAINT mock_writing_binding;
ALTER TABLE "__SCHEMA__".mock_writing ADD CONSTRAINT mock_writing_binding CHECK
 ((binding_kind='choice' AND binding_id='legacy' AND choice_group_id IS NOT NULL AND selected_option_id IS NOT NULL AND selected_option_id IN ('A','B')) OR
  (binding_kind='assigned' AND binding_id='legacy' AND choice_group_id IS NULL AND selected_option_id IS NULL) OR
  (binding_kind='required' AND binding_id<>'legacy' AND binding_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$' AND choice_group_id IS NULL AND selected_option_id IS NULL));

-- Extend the exact installed guards without replacing their owner, rights, receipt or timing checks.
-- Each replacement is required to match; a changed predecessor fails the migration atomically.
DO $migration$
DECLARE original text; revised text; needle text; replacement text; fn regprocedure;
BEGIN
 fn := '"__SCHEMA__".protect_mock_writing()'::regprocedure;
 original := pg_get_functiondef(fn);
 revised := replace(original, 'IF NEW.binding_kind=''assigned'' THEN', 'IF NEW.binding_kind IN (''assigned'',''required'') THEN');
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 original:=revised;
 needle := $old$AND f.payload#>>'{writingTask,taskId}'=a.task_id AND f.payload#>>'{writingTask,taskVersion}'=a.task_version
    AND f.payload#>>'{writingTask,section}'=task.section AND NOT (f.payload ? 'writingChoices')$old$;
 replacement := $new$AND NOT (f.payload ? 'writingChoices') AND (
     (NEW.binding_kind='assigned' AND NOT (f.payload ? 'writingTasks') AND f.payload#>>'{writingTask,taskId}'=a.task_id
      AND f.payload#>>'{writingTask,taskVersion}'=a.task_version AND f.payload#>>'{writingTask,section}'=task.section)
     OR (NEW.binding_kind='required' AND NOT (f.payload ? 'writingTask') AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(f.payload->'writingTasks') b WHERE b->>'id'=NEW.binding_id
      AND b->>'taskId'=a.task_id AND b->>'taskVersion'=a.task_version AND b->>'section'=task.section)))$new$;
 revised:=replace(original,needle,replacement);
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 original:=revised;
 revised:=replace(original,'NEW.run_id,NEW.owner_id,NEW.attempt_id,NEW.binding_kind,','NEW.run_id,NEW.owner_id,NEW.attempt_id,NEW.binding_id,NEW.binding_kind,');
 revised:=replace(revised,'OLD.run_id,OLD.owner_id,OLD.attempt_id,OLD.binding_kind,','OLD.run_id,OLD.owner_id,OLD.attempt_id,OLD.binding_id,OLD.binding_kind,');
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 EXECUTE revised;

 fn := '"__SCHEMA__".protect_mock_run()'::regprocedure;
 original:=pg_get_functiondef(fn);
 revised:=replace(original,$old$jsonb_typeof(form_payload->'writingTask')='object'$old$,
  $new$(jsonb_typeof(form_payload->'writingTask')='object' OR jsonb_array_length(coalesce(form_payload->'writingTasks','[]'::jsonb))=2)$new$);
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 EXECUTE revised;

 fn := '"__SCHEMA__".finalise_mock_run(uuid,integer)'::regprocedure;
 original:=pg_get_functiondef(fn);
 revised:=replace(original,$old$jsonb_typeof(payload->'writingTask')='object'$old$,
  $new$(jsonb_typeof(payload->'writingTask')='object' OR jsonb_array_length(coalesce(payload->'writingTasks','[]'::jsonb))=2)$new$);
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 EXECUTE revised;

 fn := '"__SCHEMA__".form_review_allowed(text,text,text,boolean)'::regprocedure;
 original:=pg_get_functiondef(fn);
 revised:=replace(original,$old$WHERE jsonb_typeof(form.payload->'writingTask')='object' LOOP$old$,
  $new$WHERE jsonb_typeof(form.payload->'writingTask')='object'
  UNION ALL SELECT value FROM jsonb_array_elements(coalesce(form.payload->'writingTasks','[]'::jsonb)) LOOP$new$);
 IF revised=original THEN RAISE EXCEPTION 'required_writing_predecessor_mismatch'; END IF;
 EXECUTE revised;
END $migration$;

CREATE FUNCTION "__SCHEMA__".require_all_writing_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path="__SCHEMA__",pg_temp AS $fn$
DECLARE bindings jsonb;
BEGIN
 IF NEW.state='finalised' AND OLD.state='active' THEN
  SELECT payload->'writingTasks' INTO bindings FROM exam_form WHERE exam_id=NEW.exam_id AND form_id=NEW.form_id AND version=NEW.form_version;
  IF bindings IS NOT NULL AND (jsonb_array_length(bindings)<>2 OR
   (SELECT count(*) FROM mock_writing WHERE run_id=NEW.id AND owner_id=NEW.owner_id)<>2 OR
   EXISTS(SELECT 1 FROM jsonb_array_elements(bindings) b WHERE NOT EXISTS(
    SELECT 1 FROM mock_writing w JOIN attempts a ON a.id=w.attempt_id AND a.owner_id=w.owner_id
    WHERE w.run_id=NEW.id AND w.owner_id=NEW.owner_id AND w.binding_kind='required' AND w.binding_id=b->>'id'
    AND a.task_id=b->>'taskId' AND a.task_version=b->>'taskVersion')))
  THEN RAISE EXCEPTION 'invalid_mock_writing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".require_all_writing_bindings() FROM PUBLIC;
CREATE TRIGGER require_all_writing_bindings BEFORE UPDATE ON "__SCHEMA__".mock_run
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".require_all_writing_bindings();

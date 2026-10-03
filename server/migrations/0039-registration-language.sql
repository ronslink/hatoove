-- Only a newly registered account receives the explicitly selected interface language.
-- No backfill, broader auth grants or update of an existing learner preference.
CREATE OR REPLACE FUNCTION "__SCHEMA__".initialize_registered_language()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = "__SCHEMA__", pg_temp
AS $fn$
DECLARE
  selected_language text;
  previous_owner text;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW'
     OR TG_TABLE_SCHEMA <> '__SCHEMA__' OR TG_TABLE_NAME <> 'user' THEN
    RAISE EXCEPTION 'language_initialization_requires_account_insert' USING ERRCODE = 'insufficient_privilege';
  END IF;
  selected_language := nullif(pg_catalog.current_setting('hatoove.registration_language', true), '');
  IF selected_language IS NULL THEN RETURN NEW; END IF;
  IF selected_language NOT IN ('de','en','uk','ar','tr') THEN
    RAISE EXCEPTION 'invalid_registration_language' USING ERRCODE = 'check_violation';
  END IF;
  previous_owner := pg_catalog.current_setting('hatoove.owner_id', true);
  PERFORM pg_catalog.set_config('hatoove.owner_id', NEW.id, true);
  INSERT INTO "__SCHEMA__".learner_settings(user_id, language, revision)
    VALUES (NEW.id, selected_language, 0);
  PERFORM pg_catalog.set_config('hatoove.owner_id', coalesce(previous_owner, ''), true);
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".initialize_registered_language()
  FROM PUBLIC, "__AUTH__", "__LEARNER__", "__WORKER__", "__DELETION__", "__PAYMENTS__";
REVOKE TRIGGER ON "__SCHEMA__"."user" FROM "__AUTH__";
DROP TRIGGER IF EXISTS initialize_registered_language ON "__SCHEMA__"."user";
CREATE TRIGGER initialize_registered_language AFTER INSERT ON "__SCHEMA__"."user"
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".initialize_registered_language();

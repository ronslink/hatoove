-- REDESIGN-01 E: bind a targeted retry to the exact served item. Existing attempts remain unchanged.
ALTER TABLE "__SCHEMA__".practice_attempt ADD COLUMN IF NOT EXISTS retry_item_id text;
ALTER TABLE "__SCHEMA__".practice_attempt ADD CONSTRAINT practice_retry_single_item
  CHECK (retry_item_id IS NULL OR (item_count = 1 AND mode = 'part' AND retry_item_id ~ '^[A-Za-z0-9._-]{1,64}$'));
GRANT INSERT (retry_item_id) ON "__SCHEMA__".practice_attempt TO "__LEARNER__";

CREATE FUNCTION "__SCHEMA__".protect_practice_retry() RETURNS trigger
LANGUAGE plpgsql SET search_path = "__SCHEMA__", pg_temp AS $fn$
BEGIN
  IF NEW.retry_item_id IS DISTINCT FROM OLD.retry_item_id THEN
    RAISE EXCEPTION 'practice_attempt_identity_immutable';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_practice_retry() FROM PUBLIC;
CREATE TRIGGER practice_retry_identity BEFORE UPDATE ON "__SCHEMA__".practice_attempt
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_practice_retry();

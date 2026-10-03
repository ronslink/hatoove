-- Rights decisions and grading/publication must share one transaction fence per exam.
-- No existing decision or content row is changed; their UPDATE/DELETE guards remain intact.
CREATE FUNCTION "__SCHEMA__".fence_content_rights_insert() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,"__SCHEMA__" AS $fn$
DECLARE bound_exam text;
BEGIN
 SELECT exam_id INTO bound_exam FROM "__SCHEMA__".content_version
  WHERE content_version_id=NEW.content_version_id;
 IF NOT FOUND OR bound_exam IS NULL THEN
  RAISE EXCEPTION 'rights_content_not_found' USING ERRCODE='23503';
 END IF;
 -- content_version identity is immutable, so this read needs no tuple lock.
 -- Match importer/worker exam key exactly; never acquire an owner/job lock here.
 -- Multi-exam administrative transactions must prelock their exam keys in sorted order.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(bound_exam,7351));
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".fence_content_rights_insert() FROM PUBLIC;
CREATE TRIGGER content_rights_insert_fence BEFORE INSERT ON "__SCHEMA__".content_rights
 FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".fence_content_rights_insert();

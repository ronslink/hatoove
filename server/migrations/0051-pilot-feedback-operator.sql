-- PILOT-FEEDBACK-01 (slice FB-D) — the OPERATOR surface: how a human reads the table, and the only way they can
-- change it.
--
-- WHY THE OPERATOR IS NOT THE MIGRATION ROLE. The person triaging feedback needs to read rows that belong to
-- learners, which no learner-fenced policy allows, and to mark a report handled. Handing them the migration role
-- would also hand them the schema: every table, every DDL statement, every learner's writing. So this file gives
-- the `operator` role EXECUTE on five functions and **no table privilege at all** — a `SELECT` on
-- `pilot_feedback` as the operator is refused by PostgreSQL, which is a property a reviewer can check rather than
-- a convention someone has to remember.
--
-- THE BOUNDED UPDATE IS BOUNDED BY CONSTRUCTION. `operator_set_feedback_status` names exactly three columns, so
-- there is no argument that can reach a fourth. That matters because a SECURITY DEFINER function owned by the
-- migration role **is the table owner**, and `FORCE` ROW LEVEL SECURITY does not bound what it may write — the
-- trigger in `0049` (`pilot_feedback_identity_immutable`) is the second line of defence, and
-- `tools/pilot-feedback-operator-check.mjs` must PROVE both rather than assert them.
--
-- WHY EVERY FUNCTION TAKES ITS ARGUMENTS AND NOTHING ELSE. The read function joins `"user"` for the reporter's
-- name and e-mail, because a report whose author is a bare uuid is not something a human can act on. It uses a
-- LEFT JOIN on purpose: a row whose account is gone still lists, with a NULL reporter, so the CLI can say
-- "account removed" instead of rendering a blank.

/* ---------------------------------------------------------------- the read path */

/*
 * THE OWNER-SCOPED POLICY FIRST, and it is not optional. `0049` FORCEs row-level security, and FORCE means the
 * fence applies to the TABLE OWNER too — so a `SECURITY DEFINER` function owned by the schema owner reads ZERO
 * rows without a policy of its own. `0045` records the same trap for `practice_attempt`: "a plain read returned
 * ZERO rows and every play was answered not_found". The first version of this file omitted it, and the reader
 * silently returned nothing against a table that had rows.
 *
 * WHY THE POLICY NAMES THE OWNER ROLE AND NOT `CURRENT_USER`, which is what `0045` and `0025` use: those policies
 * carry an owner predicate in `USING`, so matching every session is harmless. This reader needs
 * `USING (true)` — it reads ACROSS owners by design — and `TO CURRENT_USER USING (true)` would then match the
 * LEARNER as well, who already holds SELECT on this table: every learner would read every other learner's
 * feedback. Naming the owner role keeps the policy to sessions that are already the schema owner, which is the
 * only context the definer function runs in.
 */
/*
 * AND EACH POLICY NAMES ITS COMMAND. A policy with no `FOR` is `FOR ALL`, and `ALL` includes INSERT and DELETE:
 * the first version therefore let the schema owner INSERT a report attributed to ANY learner, and delete any
 * report, neither of which this feature ever does. An independent reviewer listed it as a should-fix, and it is
 * more than tidiness — the whole point of the operator role is that it cannot reach rows except through the
 * functions, and a policy that silently grants write is the same mistake one level down.
 *
 * THE UPDATE POLICY IS REQUIRED, not excess. `operator_set_feedback_status` is SECURITY DEFINER owned by this
 * role, and `0049` FORCEs row-level security on the table, so the fence applies to the owner too: without an
 * UPDATE policy the bounded update would be refused by RLS. That bound lives in the function — three named
 * columns — and `pilot-feedback-operator-check` proves it by changing something else and observing the refusal.
 * INSERT and DELETE are withheld because nothing needs them.
 */
DROP POLICY IF EXISTS operator_feedback_read ON "__SCHEMA__".pilot_feedback;
DROP POLICY IF EXISTS operator_feedback_triage ON "__SCHEMA__".pilot_feedback;
CREATE POLICY operator_feedback_read ON "__SCHEMA__".pilot_feedback FOR SELECT TO "__MIGRATION__" USING (true);
CREATE POLICY operator_feedback_triage ON "__SCHEMA__".pilot_feedback FOR UPDATE TO "__MIGRATION__" USING (true) WITH CHECK (true);
-- The screenshots are only ever READ by the operator: the learner writes them, and deletion is the learner's.
DROP POLICY IF EXISTS operator_feedback_screenshot_read ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE POLICY operator_feedback_screenshot_read ON "__SCHEMA__".pilot_feedback_screenshot FOR SELECT TO "__MIGRATION__" USING (true);

-- p_feedback_id, p_status, p_category and p_since are all optional; NULL means "do not filter".
DROP FUNCTION IF EXISTS "__SCHEMA__".operator_feedback_list(uuid, text, text, timestamptz);
CREATE FUNCTION "__SCHEMA__".operator_feedback_list(
  p_feedback_id uuid DEFAULT NULL,
  p_status      text DEFAULT NULL,
  p_category    text DEFAULT NULL,
  p_since       timestamptz DEFAULT NULL
) RETURNS TABLE (
  feedback_id        uuid,
  owner_id           text,
  reporter_name      text,
  reporter_email     text,
  kind               text,
  category           text,
  body               text,
  route              text,
  exam_id            text,
  set_id             text,
  version            text,
  item_id            text,
  guide_id           text,
  section_id         text,
  run_id             uuid,
  interface_language text,
  app_version        text,
  survey_round       text,
  survey_answers     jsonb,
  status             text,
  operator_note      text,
  created_at         timestamptz,
  handled_at         timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, "__SCHEMA__" AS $fn$
  SELECT f.feedback_id, f.owner_id, u.name, u.email, f.kind, f.category, f.body, f.route,
         f.exam_id, f.set_id, f.version, f.item_id, f.guide_id, f.section_id, f.run_id,
         f.interface_language, f.app_version, f.survey_round, f.survey_answers,
         f.status, f.operator_note, f.created_at, f.handled_at
    FROM "__SCHEMA__".pilot_feedback f
    LEFT JOIN "__SCHEMA__"."user" u ON u.id = f.owner_id
   WHERE (p_feedback_id IS NULL OR f.feedback_id = p_feedback_id)
     AND (p_status      IS NULL OR f.status      = p_status)
     AND (p_category    IS NULL OR f.category    = p_category)
     AND (p_since       IS NULL OR f.created_at >= p_since)
   ORDER BY f.created_at DESC, f.feedback_id
$fn$;

/* ---------------------------------------------------------------- the bounded write path */

-- The ONLY way the operator changes a row: three columns, and a status from the closed set.
DROP FUNCTION IF EXISTS "__SCHEMA__".operator_set_feedback_status(uuid, text, text);
CREATE FUNCTION "__SCHEMA__".operator_set_feedback_status(
  p_feedback_id uuid,
  p_status      text,
  p_note        text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "__SCHEMA__" AS $fn$
DECLARE
  touched integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('new', 'triaged', 'fixed', 'wontfix') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '23514';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN
    RAISE EXCEPTION 'invalid_note' USING ERRCODE = '23514';
  END IF;
  -- THREE COLUMNS. Not "the operator may only change these" — the statement cannot change anything else.
  --
  -- AND A MISSING NOTE PRESERVES THE EXISTING ONE. `operator_note = p_note` ERASED it: the reviewer ran
  -- `set-status <id> triaged` with no `--note` and the note written on an earlier triage was silently gone. A
  -- status change and a note change are different intents, and the caller that wants only the first should not
  -- have to re-send the second. `COALESCE` keeps the old note when none is given; an EMPTY STRING is not NULL, so
  -- `--note ""` still clears it deliberately.
  UPDATE "__SCHEMA__".pilot_feedback
     SET status        = p_status,
         operator_note = COALESCE(p_note, operator_note),
         handled_at    = CASE WHEN p_status = 'new' THEN NULL ELSE now() END
   WHERE feedback_id = p_feedback_id;
  GET DIAGNOSTICS touched = ROW_COUNT;
  RETURN touched > 0;
END $fn$;

/* ---------------------------------------------------------------- retention */

-- Retention clean-up. Returns how many rows it removed, so an operator sees the effect rather than assuming it.
DROP FUNCTION IF EXISTS "__SCHEMA__".operator_purge_feedback(integer);
CREATE FUNCTION "__SCHEMA__".operator_purge_feedback(p_older_than_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "__SCHEMA__" AS $fn$
DECLARE
  removed integer;
BEGIN
  IF p_older_than_days IS NULL OR p_older_than_days < 1 THEN
    RAISE EXCEPTION 'invalid_retention' USING ERRCODE = '23514';
  END IF;
  -- The screenshot goes first: it references the report, and the cascade would take it anyway, but an explicit
  -- order is what the deletion steps do and it keeps the two paths reading the same way.
  DELETE FROM "__SCHEMA__".pilot_feedback_screenshot s
   USING "__SCHEMA__".pilot_feedback f
   WHERE s.feedback_id = f.feedback_id
     AND f.created_at < now() - make_interval(days => p_older_than_days);
  DELETE FROM "__SCHEMA__".pilot_feedback
   WHERE created_at < now() - make_interval(days => p_older_than_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $fn$;

/* ---------------------------------------------------------------- the survey seed */

-- The migration does NOT hard-code round dates (contract §1), so this is how a round exists at all. The
-- immutability trigger in `0049` still applies through this function: a round's id and question set are frozen
-- once written, so a second seed for the same round is refused rather than silently re-meaning stored answers.
DROP FUNCTION IF EXISTS "__SCHEMA__".operator_seed_survey_round(text, timestamptz, timestamptz, jsonb, integer);
CREATE FUNCTION "__SCHEMA__".operator_seed_survey_round(
  p_round_id             text,
  p_opens_at             timestamptz,
  p_closes_at            timestamptz,
  p_questions            jsonb,
  p_min_account_age_days integer DEFAULT 7
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "__SCHEMA__" AS $fn$
BEGIN
  INSERT INTO "__SCHEMA__".survey_round(round_id, opens_at, closes_at, questions, min_account_age_days)
  VALUES (p_round_id, p_opens_at, p_closes_at, p_questions, p_min_account_age_days)
  ON CONFLICT (round_id) DO NOTHING;
  RETURN FOUND;
END $fn$;

/* ---------------------------------------------------------------- the screenshot */

-- The bytes leave through a function, like everything else, so the operator holds no table privilege even for
-- this. `show --save-screenshot` uses it; the learner's own export reads theirs through the learner policy.
DROP FUNCTION IF EXISTS "__SCHEMA__".operator_feedback_screenshot(uuid);
CREATE FUNCTION "__SCHEMA__".operator_feedback_screenshot(p_feedback_id uuid)
RETURNS TABLE (mime_type text, bytes bytea, width integer, height integer, sha256 text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, "__SCHEMA__" AS $fn$
  SELECT s.mime_type, s.bytes, s.width, s.height, s.sha256, s.created_at
    FROM "__SCHEMA__".pilot_feedback_screenshot s
   WHERE s.feedback_id = p_feedback_id
$fn$;

/* ---------------------------------------------------------------- grants: the operator, and nobody else */

-- USAGE ON THE SCHEMA FIRST, and this is not a detail: without it PostgreSQL refuses to resolve ANY object in
-- the schema — including the five functions above — so the operator tool would have been dead on arrival with
-- `permission denied for schema <schema>`. The first version of this file granted only the functions, and the
-- mistake is invisible to a reader: the grants look complete. It was found by calling the function AS the
-- operator. `0003-isolation.sql:8` grants usage to the other restricted roles for the same reason.
--
-- USAGE lets the role NAME objects in the schema; it grants no table privilege, which is why the operator still
-- cannot SELECT `pilot_feedback` directly — proved by `tools/pilot-feedback-operator-check.mjs`.
GRANT USAGE ON SCHEMA "__SCHEMA__" TO "__OPERATOR__";

REVOKE ALL ON FUNCTION "__SCHEMA__".operator_feedback_list(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".operator_set_feedback_status(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".operator_purge_feedback(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".operator_seed_survey_round(text, timestamptz, timestamptz, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".operator_feedback_screenshot(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "__SCHEMA__".operator_feedback_list(uuid, text, text, timestamptz) TO "__OPERATOR__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".operator_set_feedback_status(uuid, text, text) TO "__OPERATOR__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".operator_purge_feedback(integer) TO "__OPERATOR__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".operator_seed_survey_round(text, timestamptz, timestamptz, jsonb, integer) TO "__OPERATOR__";
GRANT EXECUTE ON FUNCTION "__SCHEMA__".operator_feedback_screenshot(uuid) TO "__OPERATOR__";

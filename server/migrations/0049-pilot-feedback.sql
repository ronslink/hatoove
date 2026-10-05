-- PILOT-FEEDBACK-01 (slice FB-A) — the learner-facing feedback tables: one "Problem melden" report form for the
-- whole app, a periodic survey, and the (Stage 2) screenshot of the page a report was sent from.
-- Contract: docs/contracts/PILOT-FEEDBACK-01.md §1. Stage 1 of A2 — this file carries NO operator role and NO
-- survey seed: the `__OPERATOR__` role, its SECURITY DEFINER reader and its bounded UPDATE are 0050 (FB-D), and
-- the round dates are the operator's, so not one `survey_round` row is written here.
--
-- OWNERSHIP. `pilot_feedback` and `pilot_feedback_screenshot` are account rows: FORCE RLS on the owner, in
-- ACCOUNT_TABLES, deleted with the account and exported with it. A learner may READ and CREATE their own rows and
-- nothing else — no UPDATE, no DELETE — because a report is a record of what the learner said and the triage
-- columns (`status`, `operator_note`, `handled_at`) are the operator's. The INSERT policy refuses any row that
-- arrives with a status other than `new` or with a triage column already filled, so a client can never file a
-- report that claims to be handled.
--
-- WHY TRIGGERS AND NOT CHECKS for two rules. A CHECK constraint cannot read another table, and both rules need
-- one: a survey's `survey_answers` are valid only against ITS round's question set, and a screenshot's `owner_id` must
-- equal its report's owner. The foreign key alone does not give the second: referential checks bypass row-level
-- security, so without the trigger learner A could hang an image (owned by A) off learner B's report.
-- Both guard functions are SECURITY INVOKER on purpose: they then read through the caller's own policies, and a
-- definer owned by the migration role would see zero rows under FORCE RLS (0045 records that trap).
--
-- `survey_round` is CONTENT-CLASS: no owner, readable by the learner, written by no runtime role. A round's id and
-- question set are frozen once written (answers are validated against them, so changing them would silently
-- re-mean every stored answer); its dates and minimum account age may still be corrected. A round is never deleted.

CREATE TABLE IF NOT EXISTS "__SCHEMA__".survey_round (
  round_id             text PRIMARY KEY CHECK (round_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  opens_at             timestamptz NOT NULL,
  closes_at            timestamptz NOT NULL,
  questions            jsonb NOT NULL,
  min_account_age_days integer NOT NULL DEFAULT 7 CHECK (min_account_age_days BETWEEN 0 AND 365),
  CHECK (closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".pilot_feedback (
  feedback_id        uuid PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES "__SCHEMA__"."user"(id),
  kind               text NOT NULL CHECK (kind IN ('report', 'survey')),
  category           text CHECK (category IN ('content_error', 'audio', 'translation', 'bug', 'idea', 'other')),
  -- Plain text, stored already trimmed. It is never rendered as HTML anywhere.
  body               text,
  -- A7: the client's REAL view ids (public/app/app.js:78-82). The drafted today/practice/drill/... vocabulary
  -- matched no shipped route, and a value outside this list is a lost report, so this list must stay equal to
  -- the shell's own view ids.
  route              text CHECK (route IN ('heute', 'ueben', 'wortschatz', 'fehler', 'pruefungsteile', 'hoeren',
                                           'schreiben', 'probepruefung', 'nachschlagen', 'einstellungen', 'verlauf',
                                           'checkout', 'lesen', 'sprachbausteine', 'abschnitt', 'satzbau', 'mehr', 'other')),
  -- Captured context: what was on screen when the form opened. Never asked of the learner.
  exam_id            text CHECK (char_length(exam_id) BETWEEN 1 AND 128),
  set_id             text CHECK (char_length(set_id) BETWEEN 1 AND 128),
  version            text CHECK (char_length(version) BETWEEN 1 AND 32),
  item_id            text CHECK (char_length(item_id) BETWEEN 1 AND 64),
  guide_id           text CHECK (char_length(guide_id) BETWEEN 1 AND 128),
  section_id         text CHECK (char_length(section_id) BETWEEN 1 AND 160),
  run_id             uuid,
  interface_language text NOT NULL CHECK (interface_language IN ('de', 'en', 'uk', 'ar', 'tr')),
  -- A6: server-set, never client-set. `.reviewed-commit` is written AFTER the image build and is not inside the
  -- runtime, so in Stage 1 this is always the literal 'unknown'; the hex form stays for the later slice that
  -- threads the real SHA into the image.
  app_version        text NOT NULL DEFAULT 'unknown' CHECK (app_version ~ '^([0-9a-f]{7,40}|unknown)$'),
  survey_round       text REFERENCES "__SCHEMA__".survey_round(round_id),
  -- NULL on a survey row means the learner skipped the round.
  survey_answers     jsonb CHECK (survey_answers IS NULL OR jsonb_typeof(survey_answers) = 'object'),
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'fixed', 'wontfix')),
  operator_note      text CHECK (char_length(operator_note) <= 1000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  handled_at         timestamptz,
  CONSTRAINT pilot_feedback_report_shape CHECK (kind <> 'report' OR (
    category IS NOT NULL AND route IS NOT NULL AND body IS NOT NULL
    AND char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body, E' \t\n\r\f\v')
    AND survey_round IS NULL AND survey_answers IS NULL)),
  CONSTRAINT pilot_feedback_survey_shape CHECK (kind <> 'survey' OR (
    category IS NULL AND body IS NULL AND survey_round IS NOT NULL
    AND exam_id IS NULL AND set_id IS NULL AND version IS NULL AND item_id IS NULL
    AND guide_id IS NULL AND section_id IS NULL AND run_id IS NULL))
);

-- One survey row per learner per round: an answer and a skip are the same "already done".
CREATE UNIQUE INDEX IF NOT EXISTS pilot_feedback_one_survey_per_round
  ON "__SCHEMA__".pilot_feedback (owner_id, survey_round)
  WHERE kind = 'survey' AND survey_round IS NOT NULL;
-- Triage reads "what is new, oldest first".
CREATE INDEX IF NOT EXISTS pilot_feedback_status_idx
  ON "__SCHEMA__".pilot_feedback (status, created_at);
-- Every report about one item lists together.
CREATE INDEX IF NOT EXISTS pilot_feedback_item_idx
  ON "__SCHEMA__".pilot_feedback (exam_id, set_id, version, item_id);
-- "Meine Meldungen" lists one owner's rows, newest first.
CREATE INDEX IF NOT EXISTS pilot_feedback_owner_idx
  ON "__SCHEMA__".pilot_feedback (owner_id, created_at);

-- At most one image per report, kept apart so a listing never drags the bytes along.
CREATE TABLE IF NOT EXISTS "__SCHEMA__".pilot_feedback_screenshot (
  feedback_id uuid PRIMARY KEY REFERENCES "__SCHEMA__".pilot_feedback(feedback_id) ON DELETE CASCADE,
  owner_id    text NOT NULL REFERENCES "__SCHEMA__"."user"(id),
  mime_type   text NOT NULL CHECK (mime_type IN ('image/webp', 'image/png')),
  bytes       bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1572864),
  width       integer NOT NULL CHECK (width BETWEEN 1 AND 1600),
  height      integer NOT NULL CHECK (height > 0),
  -- The digest is the stored bytes' own, so a row can never carry a hash of different bytes.
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$' AND sha256 = encode(sha256(bytes), 'hex')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ---------------------------------------------------------------- row-level security and grants */

ALTER TABLE "__SCHEMA__".pilot_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".pilot_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".pilot_feedback_screenshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".pilot_feedback_screenshot FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learner_read_pilot_feedback ON "__SCHEMA__".pilot_feedback;
CREATE POLICY learner_read_pilot_feedback ON "__SCHEMA__".pilot_feedback FOR SELECT TO "__LEARNER__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
-- The learner files a NEW report and nothing else: no status of their choosing, no triage columns.
DROP POLICY IF EXISTS learner_insert_pilot_feedback ON "__SCHEMA__".pilot_feedback;
CREATE POLICY learner_insert_pilot_feedback ON "__SCHEMA__".pilot_feedback FOR INSERT TO "__LEARNER__"
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), '')
    AND status = 'new' AND operator_note IS NULL AND handled_at IS NULL);
-- Account erasure: a DELETE policy, plus the owner-scoped read the deletion read-back needs (a DELETE with a
-- WHERE clause is also filtered by SELECT policies, and the read-back would be vacuous without one).
DROP POLICY IF EXISTS deletion_pilot_feedback ON "__SCHEMA__".pilot_feedback;
CREATE POLICY deletion_pilot_feedback ON "__SCHEMA__".pilot_feedback FOR DELETE TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
DROP POLICY IF EXISTS deletion_read_pilot_feedback ON "__SCHEMA__".pilot_feedback;
CREATE POLICY deletion_read_pilot_feedback ON "__SCHEMA__".pilot_feedback FOR SELECT TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

DROP POLICY IF EXISTS learner_read_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE POLICY learner_read_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot FOR SELECT TO "__LEARNER__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
DROP POLICY IF EXISTS learner_insert_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE POLICY learner_insert_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot FOR INSERT TO "__LEARNER__"
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
DROP POLICY IF EXISTS deletion_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE POLICY deletion_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot FOR DELETE TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
DROP POLICY IF EXISTS deletion_read_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE POLICY deletion_read_pilot_feedback_screenshot ON "__SCHEMA__".pilot_feedback_screenshot FOR SELECT TO "__DELETION__"
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

REVOKE ALL ON "__SCHEMA__".pilot_feedback, "__SCHEMA__".pilot_feedback_screenshot, "__SCHEMA__".survey_round FROM PUBLIC;
-- SELECT and INSERT only. No UPDATE, no DELETE: the triage columns are the operator's (0050).
GRANT SELECT, INSERT ON "__SCHEMA__".pilot_feedback, "__SCHEMA__".pilot_feedback_screenshot TO "__LEARNER__";
GRANT SELECT, DELETE ON "__SCHEMA__".pilot_feedback, "__SCHEMA__".pilot_feedback_screenshot TO "__DELETION__";
GRANT SELECT ON "__SCHEMA__".survey_round TO "__LEARNER__";

/* ---------------------------------------------------------------- survey_round: question set and freeze */

-- Question set v1 shape (the seed is FB-D's): an ordered array of
--   {"id": "ease", "type": "scale", "min": 1, "max": 5}      integer answer within [min, max], 0 <= min < max <= 10
--   {"id": "next", "type": "text", "max_length": 1000}       optional text answer, 1..max_length characters
-- with unique ids and at most one text question.
CREATE OR REPLACE FUNCTION "__SCHEMA__".survey_round_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  q jsonb; ids text[] := '{}'; texts integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'survey_round_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.round_id IS DISTINCT FROM OLD.round_id OR NEW.questions IS DISTINCT FROM OLD.questions) THEN
    RAISE EXCEPTION 'survey_round_immutable' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.questions) <> 'array' OR jsonb_array_length(NEW.questions) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'survey_questions_invalid' USING ERRCODE = '23514';
  END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(NEW.questions) LOOP
    IF jsonb_typeof(q) <> 'object' OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string'
       OR NOT (q->>'id') ~ '^[a-z][a-z0-9_]{0,31}$' OR (q->>'id') = ANY(ids) THEN
      RAISE EXCEPTION 'survey_questions_invalid' USING ERRCODE = '23514';
    END IF;
    ids := ids || (q->>'id');
    IF q->>'type' = 'scale' THEN
      IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(q) k) IS DISTINCT FROM ARRAY['id', 'max', 'min', 'type']
         OR jsonb_typeof(q->'min') <> 'number' OR jsonb_typeof(q->'max') <> 'number'
         OR (q->>'min')::numeric <> trunc((q->>'min')::numeric) OR (q->>'max')::numeric <> trunc((q->>'max')::numeric)
         OR (q->>'min')::numeric < 0 OR (q->>'max')::numeric > 10 OR (q->>'min')::numeric >= (q->>'max')::numeric THEN
        RAISE EXCEPTION 'survey_questions_invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF q->>'type' = 'text' THEN
      texts := texts + 1;
      IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(q) k) IS DISTINCT FROM ARRAY['id', 'max_length', 'type']
         OR jsonb_typeof(q->'max_length') <> 'number'
         OR (q->>'max_length')::numeric <> trunc((q->>'max_length')::numeric)
         OR (q->>'max_length')::numeric NOT BETWEEN 1 AND 1000 OR texts > 1 THEN
        RAISE EXCEPTION 'survey_questions_invalid' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'survey_questions_invalid' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".survey_round_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS survey_round_immutable ON "__SCHEMA__".survey_round;
CREATE TRIGGER survey_round_immutable BEFORE INSERT OR UPDATE OR DELETE ON "__SCHEMA__".survey_round
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".survey_round_immutable();

/* ---------------------------------------------------------------- pilot_feedback: server clock, survey_answers, identity */

CREATE OR REPLACE FUNCTION "__SCHEMA__".guard_pilot_feedback() RETURNS trigger
LANGUAGE plpgsql SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  qs jsonb; q jsonb; answer record; n numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only triage moves after a report is filed (0050 grants the operator exactly these three columns).
    IF ROW(NEW.feedback_id, NEW.owner_id, NEW.kind, NEW.category, NEW.body, NEW.route, NEW.exam_id, NEW.set_id,
           NEW.version, NEW.item_id, NEW.guide_id, NEW.section_id, NEW.run_id, NEW.interface_language,
           NEW.app_version, NEW.survey_round, NEW.survey_answers, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.feedback_id, OLD.owner_id, OLD.kind, OLD.category, OLD.body, OLD.route, OLD.exam_id, OLD.set_id,
           OLD.version, OLD.item_id, OLD.guide_id, OLD.section_id, OLD.run_id, OLD.interface_language,
           OLD.app_version, OLD.survey_round, OLD.survey_answers, OLD.created_at)
    THEN RAISE EXCEPTION 'pilot_feedback_identity_immutable' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  -- The server's clock, never a caller's.
  NEW.created_at := now();
  IF NEW.kind = 'survey' AND NEW.survey_answers IS NOT NULL THEN
    SELECT questions INTO qs FROM survey_round WHERE round_id = NEW.survey_round;
    IF qs IS NULL THEN RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514'; END IF;
    FOR answer IN SELECT key, value FROM jsonb_each(NEW.survey_answers) LOOP
      SELECT value INTO q FROM jsonb_array_elements(qs) WHERE value->>'id' = answer.key;
      IF q IS NULL THEN RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514'; END IF;
      IF q->>'type' = 'scale' THEN
        IF jsonb_typeof(answer.value) <> 'number' THEN
          RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514';
        END IF;
        n := (answer.value #>> '{}')::numeric;
        IF n <> trunc(n) OR n < (q->>'min')::numeric OR n > (q->>'max')::numeric THEN
          RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514';
        END IF;
      ELSE
        IF jsonb_typeof(answer.value) <> 'string'
           OR char_length(answer.value #>> '{}') NOT BETWEEN 1 AND least(1000, (q->>'max_length')::integer) THEN
          RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514';
        END IF;
      END IF;
      q := NULL;
    END LOOP;
    -- Every rating is answered; only the text question is optional. A learner who answers nothing skips.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(qs) e
                WHERE e.value->>'type' = 'scale' AND NOT NEW.survey_answers ? (e.value->>'id')) THEN
      RAISE EXCEPTION 'survey_answers_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_pilot_feedback() FROM PUBLIC;
DROP TRIGGER IF EXISTS pilot_feedback_guard ON "__SCHEMA__".pilot_feedback;
CREATE TRIGGER pilot_feedback_guard BEFORE INSERT OR UPDATE ON "__SCHEMA__".pilot_feedback
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_pilot_feedback();

/* ---------------------------------------------------------------- screenshot: same owner as its report */

CREATE OR REPLACE FUNCTION "__SCHEMA__".guard_pilot_feedback_screenshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = "__SCHEMA__", pg_temp AS $fn$
DECLARE
  report_owner text;
BEGIN
  -- Read through the CALLER's policies: a learner cannot even see another owner's report, and any caller that
  -- can must still find the same owner on both rows.
  SELECT owner_id INTO report_owner FROM pilot_feedback WHERE feedback_id = NEW.feedback_id AND kind = 'report';
  IF report_owner IS NULL OR report_owner IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'screenshot_owner_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".guard_pilot_feedback_screenshot() FROM PUBLIC;
DROP TRIGGER IF EXISTS pilot_feedback_screenshot_owner ON "__SCHEMA__".pilot_feedback_screenshot;
CREATE TRIGGER pilot_feedback_screenshot_owner BEFORE INSERT OR UPDATE ON "__SCHEMA__".pilot_feedback_screenshot
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".guard_pilot_feedback_screenshot();

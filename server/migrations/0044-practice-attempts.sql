-- PRACTICE-01 (MIRROR-B1PREP-01 slice C) — the practice attempt, stored apart from mock runs.
--
-- WHY A SECOND TABLE. `item_evidence` records what happened to ONE item and is append-only; a mock run's
-- sitting lives in the run/form tables and is driven by a timed form. A practice sitting is neither: it is
-- untimed, it covers ONE released set of ONE part, and "Noch ein Satz" starts another. Giving it its own
-- table is what lets the two be told apart at rest — a practice answer is the evidence row with
-- `mock_run_id IS NULL`, and this table is the only record that a sitting existed at all.
--
-- WHAT IT IS NOT. No answer, no key, no explanation: those stay in `item_evidence` and behind the SECURITY
-- DEFINER readers (0015 mark_objective_item, 0021 key isolation, 0041 reveal_objective_answer). This row is
-- the sitting's identity, its state and its counts, and nothing that reveals an answer.
--
-- STATE. `open` until the learner presses "Auswerten" once; then `checked`, with the counts frozen. A checked
-- attempt cannot be reopened or recounted: the review the learner read must stay the review the row describes.
-- The trigger below enforces both the identity and the one-way state, in the shape `0030` uses for playback.
CREATE TABLE IF NOT EXISTS "__SCHEMA__".practice_attempt (
  attempt_id     uuid PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES "__SCHEMA__"."user"(id),
  exam_id        text NOT NULL,
  preparation_id uuid NOT NULL,
  set_id         text NOT NULL,
  version        text NOT NULL,
  family         text NOT NULL,
  section        text NOT NULL,
  item_count     integer NOT NULL CHECK (item_count > 0),
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'checked')),
  answered_count integer NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
  correct_count  integer NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  plays_used     integer NOT NULL DEFAULT 0 CHECK (plays_used >= 0),
  replay_used    boolean NOT NULL DEFAULT false,
  checked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (correct_count <= answered_count),
  CHECK ((state = 'open' AND checked_at IS NULL) OR (state = 'checked' AND checked_at IS NOT NULL))
);

-- Selection asks "what has this learner already practised in this part, oldest first" on every tap.
CREATE INDEX IF NOT EXISTS practice_attempt_owner_part_idx
  ON "__SCHEMA__".practice_attempt (owner_id, exam_id, family, created_at);
CREATE INDEX IF NOT EXISTS practice_attempt_owner_set_idx
  ON "__SCHEMA__".practice_attempt (owner_id, set_id, version);

ALTER TABLE "__SCHEMA__".practice_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".practice_attempt FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owned_practice_attempt ON "__SCHEMA__".practice_attempt;
CREATE POLICY owned_practice_attempt ON "__SCHEMA__".practice_attempt TO __LEARNER__
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

-- Account deletion must be able to remove a learner's sittings (0021/0023 cover the sibling tables).
DROP POLICY IF EXISTS deletion_practice_attempt ON "__SCHEMA__".practice_attempt;
CREATE POLICY deletion_practice_attempt ON "__SCHEMA__".practice_attempt TO __DELETION__
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

REVOKE ALL ON "__SCHEMA__".practice_attempt FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".practice_attempt TO "__LEARNER__";
-- An attempt is CREATED once, then only its counts and state move forward. Column grants, not table grants:
-- the identity and the set can never be rewritten from the runtime role.
GRANT INSERT (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
  ON "__SCHEMA__".practice_attempt TO "__LEARNER__";
GRANT UPDATE (state, answered_count, correct_count, plays_used, replay_used, checked_at)
  ON "__SCHEMA__".practice_attempt TO "__LEARNER__";
GRANT SELECT, DELETE ON "__SCHEMA__".practice_attempt TO "__DELETION__";

CREATE OR REPLACE FUNCTION "__SCHEMA__".protect_practice_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "__SCHEMA__", pg_temp AS $fn$
BEGIN
  IF ROW(NEW.attempt_id, NEW.owner_id, NEW.exam_id, NEW.preparation_id, NEW.set_id, NEW.version,
         NEW.family, NEW.section, NEW.item_count)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.owner_id, OLD.exam_id, OLD.preparation_id, OLD.set_id, OLD.version,
         OLD.family, OLD.section, OLD.item_count)
  THEN RAISE EXCEPTION 'practice_attempt_identity_immutable'; END IF;
  IF OLD.state = 'checked' AND NEW.state <> 'checked' THEN
    RAISE EXCEPTION 'practice_attempt_reopen_refused';
  END IF;
  IF OLD.state = 'checked'
     AND ROW(NEW.answered_count, NEW.correct_count, NEW.item_count) IS DISTINCT FROM
         ROW(OLD.answered_count, OLD.correct_count, OLD.item_count)
  THEN RAISE EXCEPTION 'practice_attempt_counts_frozen'; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION "__SCHEMA__".protect_practice_attempt() FROM PUBLIC;

DROP TRIGGER IF EXISTS practice_attempt_protect ON "__SCHEMA__".practice_attempt;
CREATE TRIGGER practice_attempt_protect BEFORE UPDATE ON "__SCHEMA__".practice_attempt
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".protect_practice_attempt();

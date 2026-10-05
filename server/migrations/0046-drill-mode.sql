-- DRILL-01 (MIRROR-B1PREP-01 slice H) — the practice sitting records WHICH PATH opened it.
--
-- WHY THIS COLUMN EXISTS. Slice C's runner and slice H's Einzelübungen both record their sitting in
-- `practice_attempt` (0044), and they must not be able to adopt each other's row:
--
--   * `POST /api/v1/practice/check` marks the WHOLE set into the attempt the runner was handed. A drill
--     answers one item at a time into ITS attempt. If one row served both, a runner checking a set the
--     drill had already partly answered would append a second evidence row per item and rewrite
--     `answered_count`/`correct_count` from the wrong baseline — the sitting's own counts would be false and
--     the learner's right/wrong tally would be doubled.
--   * `practiceSetForPart` always INSERTs a new row, so the runner can never adopt a drill row. The drill
--     could have adopted an EMPTY runner row.
--
-- Before this column the drill's row was identifiable only by an INFERENCE — `state='open' AND
-- answered_count > 0` is producible solely by the drill while `checkPracticeAttempt` closes and counts a
-- sitting in one transaction. That inference is exact today and is not asserted by slice C's own code, so a
-- later per-item save in the runner would silently break it. The column makes the invariant explicit and
-- queryable instead of inferred.
--
-- ADDITIVE, AND EVERY EXISTING ROW KEEPS ITS MEANING. The default is `'part'`, so the 0044/0045 rows are
-- the runner's sittings, exactly as they were before this migration; nothing is backfilled and nothing is
-- rewritten. `mode` joins the trigger's immutable identity row and the learner's INSERT column grant, so a
-- sitting cannot be re-labelled from the runtime role after it is created.
ALTER TABLE "__SCHEMA__".practice_attempt
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'part';

-- The two paths are the only two values; a third would be a schema change, not a runtime choice.
DO $drill_mode_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"__SCHEMA__".practice_attempt'::regclass
       AND conname = 'practice_attempt_mode_check')
  THEN
    ALTER TABLE "__SCHEMA__".practice_attempt
      ADD CONSTRAINT practice_attempt_mode_check CHECK (mode IN ('part', 'drill'));
  END IF;
END
$drill_mode_check$;

-- An attempt is CREATED once with its path, then only its counts and state move forward. This repeats 0044's
-- grant with `mode` added: a column grant is cumulative, so re-granting the identity columns is a no-op and
-- `mode` becomes insertable WITHOUT becoming updatable (the trigger would refuse the rewrite anyway; the
-- grant means the runtime role cannot even try).
GRANT INSERT (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, mode)
  ON "__SCHEMA__".practice_attempt TO "__LEARNER__";

-- THE IDENTITY ROW GAINS `mode`. 0044's function is replaced, not dropped: the trigger keeps pointing at it,
-- and the new body refuses a mode rewrite exactly as it refuses a set or item_count rewrite.
CREATE OR REPLACE FUNCTION "__SCHEMA__".protect_practice_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "__SCHEMA__", pg_temp AS $fn$
BEGIN
  IF ROW(NEW.attempt_id, NEW.owner_id, NEW.exam_id, NEW.preparation_id, NEW.set_id, NEW.version,
         NEW.family, NEW.section, NEW.item_count, NEW.mode)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.owner_id, OLD.exam_id, OLD.preparation_id, OLD.set_id, OLD.version,
         OLD.family, OLD.section, OLD.item_count, OLD.mode)
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

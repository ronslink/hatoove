
    -- PILOT-22 — item_evidence: the recorded performance signal, and the only way to mark an
    -- objective item without handing the learner role the answer key.
    --
    -- ## Why marking needs a function at all
    --
    -- `objective_key` is granted to the WORKER and to nobody else, deliberately: the answers sit
    -- inline in the authored source, so the only thing between a learner and 180 keys is that the
    -- learner role cannot read the table. But marking an answer requires comparing it to that key.
    --
    -- Granting the learner role SELECT on `objective_key` to make marking possible would undo the
    -- isolation the whole objective seed was built around. So marking happens inside a SECURITY
    -- DEFINER function: it runs as its OWNER (the migration role), reads the key, and returns ONE
    -- BOOLEAN. The expected answer never leaves the function, and the learner role still cannot read
    -- the table. `SET search_path` is pinned so the definer rights cannot be redirected by a caller's
    -- search_path.
    --
    -- ## Why evidence is append-only
    --
    -- `item_evidence` is the raw signal adaptive selection will read. It is the thing the old
    -- flat-file version kept in the browser, and it must be a RECORD rather than a mutable score: a
    -- learner corrects a mistake by answering again, and the earlier attempt stays visible as the
    -- evidence it is. The learner role is granted SELECT and INSERT and NOT UPDATE or DELETE.
    --
    -- ## Files: this migration does NOT add a worker grant
    --
    -- The AI monitoring job (PILOT-23) will read evidence per learner. It is not granted a
    -- cross-owner read here, because "the monitoring job may read everything" is a decision that
    -- should be made when the job is written, not smuggled in ahead of it.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".item_evidence (
      evidence_id  uuid PRIMARY KEY,
      owner_id     text NOT NULL REFERENCES "__SCHEMA__"."user"(id),
      exam_id      text NOT NULL,
      set_id       text NOT NULL,
      version      text NOT NULL,
      item_id      text NOT NULL,
      family       text NOT NULL,
      section      text,
      answer       jsonb NOT NULL,
      correct      boolean NOT NULL,
      latency_ms   integer,
      answered_at  timestamptz NOT NULL DEFAULT now()
    );

    -- Adaptive selection groups by SECTION (the skill axis) and checks what has been seen per set.
    CREATE INDEX IF NOT EXISTS item_evidence_owner_skill_idx
      ON "__SCHEMA__".item_evidence (owner_id, exam_id, section);
    CREATE INDEX IF NOT EXISTS item_evidence_owner_set_idx
      ON "__SCHEMA__".item_evidence (owner_id, set_id, version);

    ALTER TABLE "__SCHEMA__".item_evidence ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "__SCHEMA__".item_evidence FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS owned_item_evidence ON "__SCHEMA__".item_evidence;
    CREATE POLICY owned_item_evidence ON "__SCHEMA__".item_evidence TO __LEARNER__
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
      WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

    REVOKE ALL ON "__SCHEMA__".item_evidence FROM PUBLIC;
    -- SELECT and INSERT only. No UPDATE, no DELETE: see "why evidence is append-only" above.
    GRANT SELECT, INSERT ON "__SCHEMA__".item_evidence TO __LEARNER__;

    CREATE OR REPLACE FUNCTION "__SCHEMA__".mark_objective_item(
      p_set_id  text,
      p_version text,
      p_item_id text,
      p_answer  jsonb
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = "__SCHEMA__", pg_temp
    AS $mark$
    DECLARE
      expected jsonb;
    BEGIN
      SELECT k.answers -> p_item_id INTO expected
        FROM "__SCHEMA__".objective_key k
       WHERE k.set_id = p_set_id AND k.version = p_version;
      -- An unknown set or item is an ERROR, not a `false`: "you got it wrong" and "there is no such
      -- item" must not look the same to the caller, or a bug in the item id would silently mark a
      -- learner down.
      IF expected IS NULL THEN
        RAISE EXCEPTION 'unknown_item' USING ERRCODE = 'P0002';
      END IF;
      RETURN expected = p_answer;
    END;
    $mark$;

    REVOKE ALL ON FUNCTION "__SCHEMA__".mark_objective_item(text, text, text, jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION "__SCHEMA__".mark_objective_item(text, text, text, jsonb) TO __LEARNER__;

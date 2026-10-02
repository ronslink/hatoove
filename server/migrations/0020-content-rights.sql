
    -- D1 — THE RIGHTS DECISION, AS AN APPEND-ONLY RECORD.
    --
    -- Ron, 2 October 2026: the content is AI-generated. The per-source evidence, including what the repository
    -- CANNOT establish, is `work/implementation/CONTENT-RIGHTS-D1.md`.
    --
    -- WHY THIS IS A TABLE AND NOT A COLUMN CHANGE. `content_version` is immutable: a BEFORE UPDATE OR DELETE
    -- trigger (`content_immutable`, migration 0006) refuses every change, and that immutability is what makes an
    -- attempt's recorded content mean anything. The seed-time value `rights_status='unknown'` was TRUE when
    -- those rows were written — nobody had asked the question yet. The decision came afterwards, so it is
    -- recorded as its own row: who decided, when, on what basis, and with a note. Both facts survive, and a
    -- silent UPDATE (which the trigger would have refused anyway) destroys neither.
    --
    -- THE BASIS VALUES ARE A CLOSED SET, so a typo cannot quietly create a new rights category that the serving
    -- policy then refuses for reasons nobody can see:
    --   generated     written by a model for this product; original, no third-party text
    --   licensed      a licence exists and is recorded elsewhere
    --   commissioned  a human was paid to write it for this product
    --   unknown       no basis established; FAILS CLOSED
    --
    -- THE DECISION ROWS ARE IMMUTABLE TOO, with the same function the content rows use: a decision that can be
    -- edited in place is not an audit trail.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".content_rights (
      content_version_id text PRIMARY KEY REFERENCES "__SCHEMA__".content_version(content_version_id),
      basis              text NOT NULL CHECK (basis IN ('generated', 'licensed', 'commissioned', 'unknown')),
      decided_by         text NOT NULL CHECK (length(btrim(decided_by)) > 2),
      decided_at         timestamptz NOT NULL DEFAULT now(),
      note               text NOT NULL CHECK (length(btrim(note)) > 10)
    );

    DROP TRIGGER IF EXISTS content_rights_immutable ON "__SCHEMA__".content_rights;
    CREATE TRIGGER content_rights_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".content_rights
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();

    /*
     * EVERY EXISTING CONTENT ROW GETS THE DECISION, which is what makes the gate safe to switch on: a row
     * without a decision would fall through to its seed-time value and be refused, i.e. a set would disappear
     * from the catalogue for a reason no learner could see. The check asserts this invariant directly
     * (`tools/content-rights-check.mjs` leg 1), so content added later without a decision fails a check rather
     * than vanishing quietly.
     */
    INSERT INTO "__SCHEMA__".content_rights (content_version_id, basis, decided_by, note)
    SELECT c.content_version_id,
           'generated',
           'Ron (product owner)',
           'AI-generated for Hatoove; original text, no third-party item bank. Basis given 2 October 2026 (D1).'
      FROM "__SCHEMA__".content_version c
    ON CONFLICT (content_version_id) DO NOTHING;

    REVOKE ALL ON "__SCHEMA__".content_rights FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".content_rights TO "__LEARNER__", "__WORKER__";

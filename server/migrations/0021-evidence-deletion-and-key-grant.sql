    -- COMPLETE-CI-CLAUDE-20261002-B — two least-privilege corrections, each found by table-class-check.
    --
    -- ## 1. Account deletion could not delete an account that had answered an objective item
    --
    -- `item_evidence` (0015) arrived after the deletion port (0005) and was never wired into it: its
    -- `owner_id` references "user" with NO ACTION, the deletion role holds no privilege on it and no policy
    -- covers it, and the port's steps do not name it. So `DELETE /api/v1/account` for any learner with
    -- evidence failed at the final `DELETE FROM "user"` with 23503 and rolled back (reproduced by
    -- tools/deletion-check.mjs: 500 internal_error). Fail-closed, so nothing was half-deleted, but the
    -- learner could not delete their account at all.
    --
    -- The evidence is the learner's own record and goes with the account. It CASCADES from "user", the
    -- same way `session` and `account` already do, so the port's existing final step removes it inside the
    -- port's one transaction. The constraint is replaced in ONE statement, so no moment exists in which the
    -- column is unconstrained. Existing rows all reference a live user (the old constraint guaranteed it),
    -- so re-validation cannot fail.
    --
    -- The deletion role gets exactly what 0005 gives it on every other owned table: SELECT and DELETE, and
    -- an owner-scoped policy. The SELECT is what makes the port's pre-COMMIT read-back of `item_evidence`
    -- (ACCOUNT_TABLES) real: under FORCE RLS a role with no policy sees ZERO rows, so a read-back without
    -- this policy would pass whether or not the rows were gone. No UPDATE, and nothing for the learner role:
    -- evidence stays append-only for the learner, as 0015 decided.
    --
    -- ## 2. The worker could read every answer key, and has no use for one
    --
    -- 0010 granted `objective_key` SELECT to the worker "for marking". Marking never went that way: 0015
    -- marks inside `mark_objective_item`, a SECURITY DEFINER function owned by the migration role, and the
    -- worker marks WRITING only (server/owned-postgres/worker.mjs reads submissions/attempts/jobs and
    -- never names the key table). No runtime code path reads `objective_key` as the worker, so the grant
    -- was a standing copy of 180 answers available to the one role that also talks to a model provider.
    -- After this, NO runtime role can read the key table; marking is unchanged because the function runs as
    -- the table's owner.
    --
    -- FORWARD ONLY. No applied file is edited; 0010 still records the grant it made, and this revokes it.

    ALTER TABLE "__SCHEMA__".item_evidence
      DROP CONSTRAINT IF EXISTS item_evidence_owner_id_fkey,
      ADD CONSTRAINT item_evidence_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE;

    GRANT SELECT, DELETE ON "__SCHEMA__".item_evidence TO "__DELETION__";
    DROP POLICY IF EXISTS deletion_item_evidence ON "__SCHEMA__".item_evidence;
    CREATE POLICY deletion_item_evidence ON "__SCHEMA__".item_evidence TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

    REVOKE ALL ON "__SCHEMA__".objective_key FROM "__WORKER__";

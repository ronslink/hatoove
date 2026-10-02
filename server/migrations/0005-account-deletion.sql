
    GRANT USAGE ON SCHEMA "__SCHEMA__" TO "__DELETION__";
    GRANT SELECT, DELETE ON
      "__SCHEMA__"."user", "__SCHEMA__".session, "__SCHEMA__".account,
      "__SCHEMA__".attempts, "__SCHEMA__".drafts, "__SCHEMA__".submissions, "__SCHEMA__".jobs,
      "__SCHEMA__".assessments, "__SCHEMA__".usage_ledger, "__SCHEMA__".entitlements, "__SCHEMA__".learner_settings
      TO "__DELETION__";
    GRANT UPDATE(parent_submission_id) ON "__SCHEMA__".attempts TO "__DELETION__";
    -- FOR UPDATE on entitlements (the lock the deletion and the writer paths both take first)
    -- needs UPDATE on at least one column; the deletion never changes the row.
    GRANT UPDATE(reserved) ON "__SCHEMA__".entitlements TO "__DELETION__";
    -- FOR UPDATE on "user" (the transaction's first statement) needs UPDATE on at least one
    -- column; the deletion never changes a "user" column.
    GRANT UPDATE("updatedAt") ON "__SCHEMA__"."user" TO "__DELETION__";

    -- Owner-scoped policies for the FORCE-RLS owned tables. "user", session and account carry
    -- no RLS, so the grants above are the whole boundary there and no policy is possible.
    CREATE POLICY deletion_attempts ON "__SCHEMA__".attempts TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_submissions ON "__SCHEMA__".submissions TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_jobs ON "__SCHEMA__".jobs TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_assessments ON "__SCHEMA__".assessments TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_usage ON "__SCHEMA__".usage_ledger TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_entitlements ON "__SCHEMA__".entitlements TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_learner_settings ON "__SCHEMA__".learner_settings TO "__DELETION__"
      USING (user_id = nullif(current_setting('hatoove.owner_id', true), ''));
    CREATE POLICY deletion_drafts ON "__SCHEMA__".drafts TO "__DELETION__" USING (
      EXISTS (SELECT 1 FROM "__SCHEMA__".attempts a WHERE a.id = attempt_id AND a.owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
      OR attempt_id = ANY(
        string_to_array(nullif(current_setting('hatoove.deleting_attempts', true), ''), ',')::uuid[])
    );
  
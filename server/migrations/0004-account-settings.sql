
    CREATE TABLE IF NOT EXISTS "__SCHEMA__".learner_settings (
      user_id     text PRIMARY KEY REFERENCES "__SCHEMA__"."user"(id) ON DELETE CASCADE,
      exam_date   text NOT NULL DEFAULT '',
      daily_goal  integer NOT NULL DEFAULT 20,
      model       text NOT NULL DEFAULT 'deepseek-chat',
      theme       text NOT NULL DEFAULT 'system',
      language    text NOT NULL DEFAULT '',
      revision    integer NOT NULL DEFAULT 0,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "__SCHEMA__".learner_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "__SCHEMA__".learner_settings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS learner_settings_owner ON "__SCHEMA__".learner_settings;
    CREATE POLICY learner_settings_owner ON "__SCHEMA__".learner_settings
      USING (user_id = nullif(current_setting('hatoove.owner_id', true), ''))
      WITH CHECK (user_id = nullif(current_setting('hatoove.owner_id', true), ''));
    REVOKE ALL ON "__SCHEMA__".learner_settings FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE ON "__SCHEMA__".learner_settings TO "__LEARNER__";
  
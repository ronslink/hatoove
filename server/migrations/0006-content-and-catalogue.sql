
    CREATE TABLE IF NOT EXISTS "__SCHEMA__".content_version (
      content_version_id text PRIMARY KEY,
      kind             text NOT NULL,
      family           text NOT NULL,
      source_path      text NOT NULL,
      review_status    text NOT NULL,
      rights_status    text NOT NULL,
      content_sha256   text NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "__SCHEMA__".rubric_version (
      rubric_id          text NOT NULL,
      version            text NOT NULL,
      family             text NOT NULL,
      criteria           jsonb NOT NULL,
      max_total          integer NOT NULL,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rubric_id, version)
    );
    CREATE TABLE IF NOT EXISTS "__SCHEMA__".task_version (
      task_id            text NOT NULL,
      version            text NOT NULL,
      family             text NOT NULL,
      register           text NOT NULL,
      topic              text NOT NULL,
      situation          text NOT NULL,
      adressat           text NOT NULL,
      leitpunkte         jsonb NOT NULL,
      rubric_id          text NOT NULL,
      rubric_version     text NOT NULL,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, version),
      FOREIGN KEY (rubric_id, rubric_version) REFERENCES "__SCHEMA__".rubric_version(rubric_id, version)
    );

    -- Forward-only binding on the EXISTING tables. Nullable, MATCH SIMPLE, so stored rows keep
    -- their literal synthetic versions and are never rewritten.
    ALTER TABLE "__SCHEMA__".attempts ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE "__SCHEMA__".attempts ADD COLUMN IF NOT EXISTS rubric_id text;
    DO $do$
    BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_task_version_fk
        FOREIGN KEY (task_id, task_version) REFERENCES "__SCHEMA__".task_version(task_id, version);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;
    DO $do$
    BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_rubric_version_fk
        FOREIGN KEY (rubric_id, rubric_version) REFERENCES "__SCHEMA__".rubric_version(rubric_id, version);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;

    -- Seed the six writing prompts and the one rubric. Idempotent: re-running changes nothing.
    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256)
    VALUES
    ('writing.du.besuch-einer-freundin@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'c91613ed573921b93b59e30660273a30954f385eb3ce929cf2313e2397163583'),
    ('writing.du.geburtstag-eines-freundes@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', '2956f3d666a1ea8ef43eb756c78f860c54d2ddf08cdebd496e27e87d0793c9e8'),
    ('writing.du.umzug-und-hilfe@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', '5a9c7e41290dfdd691d0e4b4ffe4a3efe316c01b68dbd11df170124c899facff'),
    ('writing.sie.sprachkurs@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'b6523e266672042543e709f4f2facf7235297d315948701c73f36f59cd97b2f2'),
    ('writing.sie.termin-mit-dem-vermieter@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'eb7bc859a8b90684cc5dc0b0165cac79847d990e08a4532633e12905559ccaf4'),
    ('writing.sie.ausflug-mit-dem-sportverein@v1', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'da4a182be86408713e199f16f9211cd25515986170fbec096808f761389cb933'),
    ('writing.formative@v1', 'rubric', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', '58433c12f46ac86ffa73c4eb8c8083c5dd9090553e07ba7831d69aaafd124cdc')
    ON CONFLICT (content_version_id) DO NOTHING;
    INSERT INTO "__SCHEMA__".rubric_version
      (rubric_id, version, family, criteria, max_total, content_version_id)
    VALUES
    ('writing.formative', 'v1', 'writing', '[{"key":"aufgabe","label":"Aufgabenbewältigung (alle Leitpunkte)","max":15},{"key":"kommunikation","label":"Kommunikative Gestaltung (Anrede, Register, Textsorte)","max":10},{"key":"richtigkeit","label":"Formale Richtigkeit (Grammatik, Orthografie)","max":12},{"key":"ausdruck","label":"Ausdruck / Wortschatz","max":8}]'::jsonb, 45, 'writing.formative@v1')
    ON CONFLICT (rubric_id, version) DO NOTHING;
    INSERT INTO "__SCHEMA__".task_version
      (task_id, version, family, register, topic, situation, adressat, leitpunkte,
       rubric_id, rubric_version, content_version_id)
    VALUES
    ('writing.du.besuch-einer-freundin', 'v1', 'writing', 'du', 'Besuch einer Freundin', 'Ihre Freundin Anna möchte Sie im nächsten Monat besuchen. Sie fragt, wann sie kommen kann und was Sie gemeinsam unternehmen können. Antworten Sie ihr per E-Mail.', 'Ihre Freundin Anna (du)', '["Schlagen Sie einen Termin für den Besuch vor.","Erklären Sie, wie Anna am besten zu Ihnen kommt.","Beschreiben Sie, wo Anna übernachten kann.","Schlagen Sie gemeinsame Aktivitäten vor."]'::jsonb, 'writing.formative', 'v1', 'writing.du.besuch-einer-freundin@v1'),
    ('writing.du.geburtstag-eines-freundes', 'v1', 'writing', 'du', 'Geburtstag eines Freundes', 'Ihr Freund Max hat Sie zu seiner Geburtstagsfeier eingeladen. Sie möchten kommen, können aber erst später da sein. Antworten Sie auf seine Einladung.', 'Ihr Freund Max (du)', '["Bedanken Sie sich für die Einladung und sagen Sie zu.","Erklären Sie, warum Sie später kommen.","Sagen Sie, wann Sie ungefähr ankommen.","Fragen Sie, was Sie für die Feier mitbringen können."]'::jsonb, 'writing.formative', 'v1', 'writing.du.geburtstag-eines-freundes@v1'),
    ('writing.du.umzug-und-hilfe', 'v1', 'writing', 'du', 'Umzug und Hilfe', 'Sie ziehen bald in eine neue Wohnung. Ihre Freundin Julia hat Ihnen Hilfe angeboten und möchte wissen, was noch zu tun ist. Schreiben Sie ihr eine E-Mail.', 'Ihre Freundin Julia (du)', '["Bedanken Sie sich für das Hilfsangebot.","Beschreiben Sie Ihre neue Wohnung.","Nennen Sie den Termin und den Treffpunkt für den Umzug.","Erklären Sie, wobei Julia Ihnen helfen kann."]'::jsonb, 'writing.formative', 'v1', 'writing.du.umzug-und-hilfe@v1'),
    ('writing.sie.sprachkurs', 'v1', 'writing', 'Sie', 'Sprachkurs', 'Sie haben einen Deutschkurs besucht und möchten sich bei Ihrer Kursleiterin bedanken. Leider konnten Sie an den letzten zwei Terminen nicht teilnehmen.', 'Ihre Kursleiterin Frau Berger (Sie)', '["Bedanken Sie sich für den Kurs.","Erklären Sie, warum Sie zweimal gefehlt haben.","Fragen Sie, ob Sie die Unterlagen noch bekommen können.","Fragen Sie nach einem passenden Folgekurs."]'::jsonb, 'writing.formative', 'v1', 'writing.sie.sprachkurs@v1'),
    ('writing.sie.termin-mit-dem-vermieter', 'v1', 'writing', 'Sie', 'Termin mit dem Vermieter', 'Ihr Vermieter Herr Weber möchte sich am Freitag die defekte Heizung in Ihrer Wohnung ansehen. Zu diesem Termin können Sie nicht zu Hause sein. Schreiben Sie ihm eine E-Mail.', 'Ihr Vermieter Herr Weber (Sie)', '["Bedanken Sie sich für seine Nachricht.","Beschreiben Sie das Problem mit der Heizung.","Erklären Sie, warum Sie am Freitag keine Zeit haben.","Schlagen Sie einen neuen Termin vor."]'::jsonb, 'writing.formative', 'v1', 'writing.sie.termin-mit-dem-vermieter@v1'),
    ('writing.sie.ausflug-mit-dem-sportverein', 'v1', 'writing', 'Sie', 'Ausflug mit dem Sportverein', 'Ihre Trainerin Frau Neumann organisiert einen Ausflug mit dem Sportverein. Sie möchten teilnehmen und brauchen noch einige Informationen. Schreiben Sie ihr eine E-Mail.', 'Ihre Trainerin Frau Neumann (Sie)', '["Sagen Sie, dass Sie am Ausflug teilnehmen möchten.","Fragen Sie nach dem Treffpunkt und der Abfahrtszeit.","Fragen Sie nach den Kosten.","Bieten Sie Hilfe bei der Vorbereitung an."]'::jsonb, 'writing.formative', 'v1', 'writing.sie.ausflug-mit-dem-sportverein@v1')
    ON CONFLICT (task_id, version) DO NOTHING;

    -- Immutability. A versioned shared record is append-only: a correction is a new version.
    CREATE OR REPLACE FUNCTION "__SCHEMA__".content_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'content records are immutable (%.%); create a new version instead',
        TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END $fn$;
    DROP TRIGGER IF EXISTS content_version_immutable ON "__SCHEMA__".content_version;
    CREATE TRIGGER content_version_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".content_version
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();
    DROP TRIGGER IF EXISTS rubric_version_immutable ON "__SCHEMA__".rubric_version;
    CREATE TRIGGER rubric_version_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".rubric_version
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();
    DROP TRIGGER IF EXISTS task_version_immutable ON "__SCHEMA__".task_version;
    CREATE TRIGGER task_version_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".task_version
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();

    REVOKE ALL ON "__SCHEMA__".content_version, "__SCHEMA__".rubric_version, "__SCHEMA__".task_version FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".content_version, "__SCHEMA__".rubric_version, "__SCHEMA__".task_version
      TO "__LEARNER__", "__WORKER__";
  
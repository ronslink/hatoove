
    -- PILOT-06 / D4-R11 — THE EXPLANATION LANGUAGE IS SNAPSHOTTED WITH THE SUBMISSION.
    --
    -- Ron's decision for the writing feedback: "a comment in the job's snapshotted explanation language".
    -- SNAPSHOTTED is the operative word. `learner_settings.language` is the learner's CURRENT preference;
    -- if the worker read that instead, the feedback a learner reads would depend on WHEN they read it — a
    -- letter written in Ukrainian and marked after the learner switched the setting to German would come
    -- back in German, and the same submission would render differently on two days.
    --
    -- So the language is copied onto the submission at SUBMIT time and never rewritten afterwards. It
    -- travels to the grader as `explanationLanguage` and reaches the per-criterion comments.
    --
    -- The default is 'de' because every seeded prompt is German and the interface is German; an
    -- installation that has never set a language therefore grades in German rather than in nothing.
    -- Nothing is backfilled beyond that default: existing submissions genuinely have no recorded language,
    -- and inventing one from today's setting would be exactly the retro-fit this column exists to avoid.

    ALTER TABLE "__SCHEMA__".submissions
      ADD COLUMN IF NOT EXISTS explanation_language text NOT NULL DEFAULT 'de';

-- F2 LIBRARY-I18N-01 — the uk/ar/tr reference-library translations.
--
-- ADDITIVE ONLY. Nothing here rewrites a guide, a section, a noun, a content version, a review
-- decision or an applied migration. The two tables are new; every existing row keeps its bytes.
--
-- WHY 0042 AND NOT 0013/0014. Those files are applied in production with frozen checksums
-- (MIRROR-B1PREP-01 §2). A new body of content therefore ships as a NEW migration, exactly as the
-- §7 content corrections ship as 0043.
--
-- WHAT THESE TABLES HOLD. The offline bundle
--   content/library-translations/hatoove-library-translations-uk-ar-tr.json
-- (sha256 f916bc94853f87b723f7b29542554bd4a4194330406f2b1d385efcee2d23776d, 737 guide strings
-- across the seven guides plus 240 noun rows, delivered by slice F2) is imported into these two
-- tables by `server/library-translations.mjs` through `tools/import-library-translations.mjs`.
-- The migration itself seeds NO translation row: the bundle is the reviewed artifact and it is
-- pinned by digest, so copying 977 rows of it into a frozen .sql file would create a second copy
-- free to drift from the pinned one.
--
-- REVIEW STATE IS A COLUMN, NOT A CLAIM. `review_status` defaults to `machine_unreviewed` and the
-- importer writes only that value: no agent may mark a translation approved (contract §4.4, §8).
-- Native review is still owed, and the client keeps the "maschinell übersetzt · Prüfung
-- ausstehend" marker until it happens.
--
-- STALENESS IS STORED, NOT GUESSED. `source_content_version` records the content version the
-- translation was generated from. A later guide version makes the row stale, and the read path
-- (contract §4.3) never serves a stale row as current: it filters on the version that is current
-- at read time. That is why the column is NOT NULL and carries a real foreign key.
--
-- NOTHING HERE IS AN ANSWER. A guide or a lexicon holds no answers, so these tables hold none
-- either: they are the same public prose in three more languages and need no key side.

CREATE TABLE "__SCHEMA__".guide_translation (
  guide_id               text NOT NULL,
  section_id             text NOT NULL,
  path                   text NOT NULL,
  locale                 text NOT NULL,
  text                   text NOT NULL,
  review_status          text NOT NULL DEFAULT 'machine_unreviewed',
  reviewer               text,
  reviewed_at            timestamptz,
  source_content_version text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (path, locale),
  -- The path is `<guide_id>/<section_id>.<field path>`, so the section is carried twice on purpose:
  -- the FK below then proves the section exists and the two id columns can never disagree with the
  -- path the client looks up by.
  CONSTRAINT guide_translation_path_check CHECK (
    position((guide_id || '/' || section_id || '.') IN path) = 1
    AND length(path) > length(guide_id) + length(section_id) + 2),
  CONSTRAINT guide_translation_locale_check CHECK (locale IN ('uk','ar','tr')),
  CONSTRAINT guide_translation_status_check CHECK (review_status IN ('machine_unreviewed','approved','rejected')),
  -- A machine row carries no reviewer and no review time; an approved or rejected row carries both.
  -- One CHECK, so "reviewed but nobody reviewed it" cannot be stored in either direction.
  CONSTRAINT guide_translation_reviewer_check CHECK (
    (review_status = 'machine_unreviewed') = (reviewer IS NULL AND reviewed_at IS NULL)),
  CONSTRAINT guide_translation_text_check CHECK (text <> ''),
  FOREIGN KEY (guide_id, section_id) REFERENCES "__SCHEMA__".guide_section(guide_id, section_id)
);

-- The read path asks for one guide in one locale and skips rejected rows.
CREATE INDEX IF NOT EXISTS guide_translation_serving_idx
  ON "__SCHEMA__".guide_translation (guide_id, locale, review_status);

CREATE TABLE "__SCHEMA__".noun_translation (
  entry_id               text NOT NULL REFERENCES "__SCHEMA__".noun_entry(entry_id),
  locale                 text NOT NULL,
  meaning                text NOT NULL,
  example                text NOT NULL,
  rule                   text NOT NULL,
  review_status          text NOT NULL DEFAULT 'machine_unreviewed',
  reviewer               text,
  reviewed_at            timestamptz,
  source_content_version text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, locale),
  CONSTRAINT noun_translation_locale_check CHECK (locale IN ('uk','ar','tr')),
  CONSTRAINT noun_translation_status_check CHECK (review_status IN ('machine_unreviewed','approved','rejected')),
  CONSTRAINT noun_translation_reviewer_check CHECK (
    (review_status = 'machine_unreviewed') = (reviewer IS NULL AND reviewed_at IS NULL)),
  CONSTRAINT noun_translation_text_check CHECK (meaning <> '' AND example <> '' AND rule <> '')
);

-- The read path asks for one locale across the lexicon and skips rejected rows.
CREATE INDEX IF NOT EXISTS noun_translation_serving_idx
  ON "__SCHEMA__".noun_translation (locale, review_status);

-- Least privilege, exactly as 0040 does it: no runtime role may insert, update or delete a
-- translation (the importer runs as the schema owner, the review workflow will be its own slice),
-- the learner role reads the reference library, and the auth/deletion/payments roles get nothing.
REVOKE ALL ON "__SCHEMA__".guide_translation, "__SCHEMA__".noun_translation
  FROM PUBLIC, "__AUTH__", "__LEARNER__", "__WORKER__", "__DELETION__", "__PAYMENTS__";
GRANT SELECT ON "__SCHEMA__".guide_translation, "__SCHEMA__".noun_translation TO "__LEARNER__", "__WORKER__";

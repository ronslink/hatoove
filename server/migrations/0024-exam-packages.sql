-- EXAM-S2: immutable package identities and a publisher-only active release pointer.
-- No learner records or historical content bytes are rewritten.
CREATE TABLE "__SCHEMA__".exam_blueprint (
  exam_id text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id),
  version text NOT NULL, payload jsonb NOT NULL, sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(exam_id,version)
);
CREATE TABLE "__SCHEMA__".exam_release (
  exam_id text NOT NULL, version text NOT NULL, blueprint_version text NOT NULL,
  state text NOT NULL CHECK(state IN ('hidden','internal','available','withdrawn')),
  manifest jsonb NOT NULL, sha256 text NOT NULL, publisher text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(exam_id,version),
  FOREIGN KEY(exam_id,blueprint_version) REFERENCES "__SCHEMA__".exam_blueprint(exam_id,version)
);
CREATE TABLE "__SCHEMA__".exam_form (
  exam_id text NOT NULL, form_id text NOT NULL, version text NOT NULL, blueprint_version text NOT NULL,
  payload jsonb NOT NULL, sha256 text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(exam_id,form_id,version),
  FOREIGN KEY(exam_id,blueprint_version) REFERENCES "__SCHEMA__".exam_blueprint(exam_id,version)
);
CREATE TABLE "__SCHEMA__".exam_form_member (
  exam_id text NOT NULL, form_id text NOT NULL, form_version text NOT NULL,
  position integer NOT NULL CHECK(position>=0), set_id text NOT NULL, set_version text NOT NULL,
  interaction text NOT NULL, item_count integer NOT NULL CHECK(item_count>0),
  PRIMARY KEY(exam_id,form_id,form_version,position),
  UNIQUE(exam_id,form_id,form_version,set_id,set_version),
  FOREIGN KEY(exam_id,form_id,form_version) REFERENCES "__SCHEMA__".exam_form(exam_id,form_id,version),
  FOREIGN KEY(set_id,set_version,exam_id) REFERENCES "__SCHEMA__".objective_set(set_id,version,exam_id)
);
CREATE TABLE "__SCHEMA__".exam_release_form (
  exam_id text NOT NULL, release_version text NOT NULL, form_id text NOT NULL, form_version text NOT NULL,
  PRIMARY KEY(exam_id,release_version,form_id,form_version),
  FOREIGN KEY(exam_id,release_version) REFERENCES "__SCHEMA__".exam_release(exam_id,version),
  FOREIGN KEY(exam_id,form_id,form_version) REFERENCES "__SCHEMA__".exam_form(exam_id,form_id,version)
);
CREATE TABLE "__SCHEMA__".exam_release_head (
  exam_id text PRIMARY KEY, release_version text NOT NULL,
  FOREIGN KEY(exam_id,release_version) REFERENCES "__SCHEMA__".exam_release(exam_id,version)
);
DO $block$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['exam_blueprint','exam_release','exam_form','exam_form_member','exam_release_form'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON "__SCHEMA__".%I FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable()',tbl||'_immutable',tbl);
  END LOOP;
  -- A pinned form is only immutable when its referenced public payload AND protected key are immutable.
  FOREACH tbl IN ARRAY ARRAY['objective_set','objective_key'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON "__SCHEMA__".%I FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable()',tbl||'_immutable',tbl);
  END LOOP;
END $block$;
REVOKE ALL ON "__SCHEMA__".exam_blueprint,"__SCHEMA__".exam_release,"__SCHEMA__".exam_form,
 "__SCHEMA__".exam_form_member,"__SCHEMA__".exam_release_form,"__SCHEMA__".exam_release_head FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".exam_blueprint,"__SCHEMA__".exam_release,"__SCHEMA__".exam_form,
 "__SCHEMA__".exam_form_member,"__SCHEMA__".exam_release_form,"__SCHEMA__".exam_release_head TO "__LEARNER__";

-- Exact private media metadata; no existing package bytes or learner records change.
ALTER TABLE "__SCHEMA__".content_version ADD CONSTRAINT content_version_identity_exam_unique UNIQUE(content_version_id,exam_id);
CREATE TABLE "__SCHEMA__".exam_media (
  media_id text NOT NULL, version text NOT NULL, exam_id text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id),
  path text NOT NULL CHECK(path LIKE 'content/exams/%'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 44 AND 33554432),
  duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 1 AND 3600000),
  mime_type text NOT NULL CHECK(mime_type='audio/wav'),
  content_version_id text NOT NULL UNIQUE,
  PRIMARY KEY(media_id,version), UNIQUE(media_id,version,exam_id),
  FOREIGN KEY(content_version_id,exam_id) REFERENCES "__SCHEMA__".content_version(content_version_id,exam_id)
);
CREATE TRIGGER exam_media_immutable BEFORE UPDATE OR DELETE ON "__SCHEMA__".exam_media
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".content_immutable();
REVOKE ALL ON "__SCHEMA__".exam_media FROM PUBLIC;
GRANT SELECT ON "__SCHEMA__".exam_media TO "__LEARNER__";

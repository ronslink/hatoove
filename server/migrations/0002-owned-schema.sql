-- Contract 0.1.0. Synthetic spike records only; auth schema comes from pinned library.
CREATE TABLE attempts (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id),
 task_version text NOT NULL, rubric_version text NOT NULL,
 parent_submission_id uuid, deleted_at timestamptz,
 UNIQUE(id, owner_id)
);
CREATE TABLE drafts (
 attempt_id uuid PRIMARY KEY REFERENCES attempts(id),
 revision integer NOT NULL CHECK(revision > 0), text text NOT NULL CHECK(length(text) <= 12000)
);
CREATE TABLE entitlements (
 owner_id text PRIMARY KEY REFERENCES "user"(id),
 allowance integer NOT NULL CHECK(allowance >= 0),
 used integer NOT NULL DEFAULT 0 CHECK(used >= 0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved >= 0),
 CHECK(used + reserved <= allowance)
);
CREATE TABLE submissions (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL, owner_id text NOT NULL,
 event_id uuid NOT NULL, draft_revision integer NOT NULL, text text NOT NULL,
 task_version text NOT NULL, rubric_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(attempt_id, owner_id) REFERENCES attempts(id, owner_id),
 UNIQUE(owner_id, event_id), UNIQUE(attempt_id, draft_revision), UNIQUE(id, owner_id)
);
ALTER TABLE attempts ADD FOREIGN KEY(parent_submission_id, owner_id) REFERENCES submissions(id, owner_id);
CREATE FUNCTION immutable_submission() RETURNS trigger LANGUAGE plpgsql AS
  'BEGIN RAISE EXCEPTION ''submission snapshots are immutable''; END';
CREATE TRIGGER immutable_submission BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION immutable_submission();
CREATE TABLE jobs (
 id uuid PRIMARY KEY, submission_id uuid NOT NULL UNIQUE, owner_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 lease_token uuid, lease_until timestamptz, tries integer NOT NULL DEFAULT 0,
 failure_code text, FOREIGN KEY(submission_id, owner_id) REFERENCES submissions(id, owner_id)
);
CREATE TABLE assessments (
 submission_id uuid PRIMARY KEY, owner_id text NOT NULL,
 feedback jsonb NOT NULL, model_version text NOT NULL, prompt_version text NOT NULL,
 rubric_version text NOT NULL, FOREIGN KEY(submission_id, owner_id) REFERENCES submissions(id, owner_id)
);
CREATE TABLE usage_ledger (
 submission_id uuid PRIMARY KEY REFERENCES assessments(submission_id),
 owner_id text NOT NULL, units integer NOT NULL CHECK(units = 1),
 FOREIGN KEY(submission_id, owner_id) REFERENCES submissions(id, owner_id)
);

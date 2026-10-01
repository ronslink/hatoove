-- Local role/RLS experiment layered on schema.sql. Identifiers are substituted
-- only by the fixture's validated random schema/role names. No production runner.
REVOKE ALL ON SCHEMA __SCHEMA__ FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA __SCHEMA__ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA __SCHEMA__ FROM PUBLIC;
-- Per-schema REVOKE cannot remove the default global PUBLIC EXECUTE grant.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA __SCHEMA__ TO __AUTH__, __LEARNER__, __WORKER__;

GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification TO __AUTH__;
GRANT SELECT, INSERT ON attempts, submissions, jobs TO __LEARNER__;
GRANT UPDATE(deleted_at) ON attempts TO __LEARNER__;
GRANT SELECT, INSERT, UPDATE, DELETE ON drafts TO __LEARNER__;
GRANT SELECT ON entitlements, assessments, usage_ledger TO __LEARNER__;
GRANT UPDATE(reserved) ON entitlements TO __LEARNER__;
GRANT UPDATE(status,lease_token,lease_until,failure_code) ON jobs TO __LEARNER__;

GRANT SELECT ON attempts, submissions, jobs, entitlements, assessments, usage_ledger TO __WORKER__;
-- PostgreSQL requires UPDATE privilege on at least one column for FOR UPDATE.
GRANT UPDATE(deleted_at) ON attempts TO __WORKER__;
GRANT UPDATE(used,reserved) ON entitlements TO __WORKER__;
GRANT UPDATE(status,lease_token,lease_until,tries,failure_code) ON jobs TO __WORKER__;
GRANT INSERT ON assessments, usage_ledger TO __WORKER__;

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY owned_attempts ON attempts TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''))
 WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_drafts ON drafts TO __LEARNER__
 USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id=attempt_id
   AND a.owner_id=nullif(current_setting('hatoove.owner_id',true),'')))
 WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id=attempt_id
   AND a.owner_id=nullif(current_setting('hatoove.owner_id',true),'')));
CREATE POLICY owned_entitlements ON entitlements TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''))
 WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_submissions ON submissions TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''))
 WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_job_read ON jobs FOR SELECT TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_job_insert ON jobs FOR INSERT TO __LEARNER__
 WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id',true),'')
   AND status='queued' AND lease_token IS NULL AND lease_until IS NULL AND tries=0);
CREATE POLICY owned_job_update ON jobs FOR UPDATE TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),'')
   AND status IN ('queued','running','failed'))
 WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id',true),'')
   AND status IN ('queued','cancelled') AND lease_token IS NULL AND lease_until IS NULL);
CREATE POLICY owned_assessments ON assessments FOR SELECT TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''));
CREATE POLICY owned_usage ON usage_ledger FOR SELECT TO __LEARNER__
 USING (owner_id = nullif(current_setting('hatoove.owner_id',true),''));

-- The trusted background process needs cross-account jobs; this is an explicit
-- role policy, not BYPASSRLS. Its SQL grants still restrict tables and columns.
CREATE POLICY worker_attempts ON attempts TO __WORKER__ USING(true) WITH CHECK(true);
CREATE POLICY worker_submissions ON submissions FOR SELECT TO __WORKER__ USING(true);
CREATE POLICY worker_jobs ON jobs TO __WORKER__ USING(true) WITH CHECK(true);
CREATE POLICY worker_entitlements ON entitlements TO __WORKER__ USING(true) WITH CHECK(true);
CREATE POLICY worker_assessments ON assessments TO __WORKER__ USING(true) WITH CHECK(true);
CREATE POLICY worker_usage ON usage_ledger TO __WORKER__ USING(true) WITH CHECK(true);

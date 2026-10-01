-- MFP-02a — provision ONE learner without a privileged runtime pool.
--
-- Why a function and not a grant: the auth role must not be able to INSERT into `entitlements`
-- directly — that would let a compromised auth path mint allowance. The least privilege the
-- sign-up path actually needs is "create the entitlement row for the account I just created",
-- and nothing more: no UPDATE, no DELETE, no reading another owner's allowance, no INSERT
-- anywhere else. A SECURITY DEFINER function is exactly that shape. It replaces MFP-01's
-- `<prefix>_provisioner` stopgap role (`provision.mjs`, `grantProvisionerRights`), which the
-- running server no longer opens.
--
-- The definer is the migration role, which OWNS the schema. It is still subject to FORCE ROW
-- LEVEL SECURITY on `entitlements` — that is the programme's isolation invariant, and MFP-02a
-- does not weaken it — so the insert it performs needs its own permissive INSERT policy,
-- `provision_learner_insert`, scoped `TO CURRENT_USER` (the defining role, resolved here to the
-- migration role). The auth role cannot use that policy: inside a SECURITY DEFINER body
-- `current_user` is the definer, and outside it the auth role holds no INSERT privilege and
-- matches no policy, so its own insert is refused. That pair is what the check leg
-- `auth-cannot-mint-allowance-directly-but-can-through-the-function` proves.
--
-- Idempotent: a retried sign-up must not fail. A duplicate `owner_id` is swallowed (the account
-- already has its allowance, which is never overwritten); every other error propagates.

CREATE OR REPLACE FUNCTION "__SCHEMA__".provision_learner(user_id text, allowance integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = "__SCHEMA__", pg_catalog
AS $fn$
BEGIN
  IF allowance IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO "__SCHEMA__".entitlements(owner_id, allowance) VALUES (user_id, allowance);
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- already provisioned: idempotent, and the existing allowance is left alone
  END;
END
$fn$;

-- What lets the DEFINER's own insert through FORCE RLS. Scoped to CURRENT_USER at creation
-- time, so the recorded policy names the migration role explicitly and no runtime role matches.
DROP POLICY IF EXISTS provision_learner_insert ON "__SCHEMA__".entitlements;
CREATE POLICY provision_learner_insert ON "__SCHEMA__".entitlements
  FOR INSERT TO CURRENT_USER WITH CHECK (true);

-- The callable surface: the auth role, and nobody else. (0003 already revokes the schema owner's
-- global PUBLIC EXECUTE default; this is explicit and idempotent.)
REVOKE ALL ON FUNCTION "__SCHEMA__".provision_learner(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "__SCHEMA__".provision_learner(text, integer) TO "__AUTH__";

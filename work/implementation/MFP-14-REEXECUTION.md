MFP-14 verified by execution: the table-class check passes, its mutation proof detects 4/4, and the journey counter reads 4/7/0

The MFP-14 run stopped before writing its own step-5 record — its status table still says steps 2-5
are "pending" while the commits for 2, 3 and 4 are all pushed. So I re-executed the checks myself on
a FRESH disposable database rather than accepting the branch's own account of itself. This record is
that execution.

WHAT IS ON THE BRANCH (tools/table-class-check.mjs, tools/table-class-check.test.mjs,
tools/journey-api-check.mjs, tools/lib/catalogue.mjs, work/implementation/MFP-14.md), against
codex/mfp-14-checks-now @ 2fc6121.

1. TABLE-CLASS CHECK — 18 table rows, 0 failures, 1 finding. Every table in schema hatoove
   classifies, and every class rule holds:
     * auth (no RLS, auth role only): account, session, user, verification;
     * owned (FORCE RLS + learner owner policy + in ACCOUNT_TABLES + an FK path to "user"):
       assessments, attempts, drafts, entitlements, jobs, learner_settings, submissions, usage_ledger;
     * shared content (no runtime DML grant + immutability trigger): content_version, rubric_version,
       task_version;
     * all 5 schema roles hold no SUPERUSER/BYPASSRLS;
     * the answer-key no-SELECT rule is asserted and reports "none exist yet" - so the day a key table
       is added it is caught, which is the point of asserting a rule with zero subjects.
   FINDING, reported not failed: hatoove_migrations records NO CHECKSUM (fix owner MFP-01). That is
   the second independent confirmation of the same defect - the architect review found it by reading
   provision.mjs, and this check found it against a live database. MFP-01 is therefore not merely
   next on the critical path; it is a defect the new check independently reproduces.

2. THE MUTATION PROOF — 4/4 detected, plus the control. Run with node --test on the same database:
     * control: the check passes on the unmutated scratch schema;
     * mutation 1: dropping one owner policy fails the owned rule;
     * mutation 2: removing one table from ACCOUNT_TABLES fails the owned rule - which is precisely
       the drift that would let account deletion stop covering a table while deletion-check stays
       18/18 green;
     * mutation 3: granting INSERT on task_version to the learner role fails the shared-content rule;
     * mutation 4: adding an unclassified table fails the unclassified rule.
   6 tests, 6 pass. A check whose four mutations are all detected is evidence; one that cannot fail
   is not, and this programme has shipped that defect more than once.

3. THE JOURNEY COUNTER — "4 passed, 7 pending, 0 failed", over HTTP against a configured runtime
   (B1PREP_ACCOUNTS=1, real PostgreSQL). This is the deliverable that turns "functional" into a
   number that moves, and it is honest by construction: a leg whose route does not exist reports
   PENDING with the slice that will satisfy it and does NOT count as a pass.
     PASSING TODAY - the product legs that genuinely work:
       J1 sign up with email and password; get-session and /api/v1/account agree on the user;
       J2 first-run setup: exam date and explanation language round-trip at revision 1;
       J5 write and autosave: create 201, save to revision 2, a stale save is refused 409, and
          another account gets 404;
       J6 submit, with duplicate clicks idempotent: submit 202, replay 202 replay:true, job queued.
     PENDING, each naming its slice: J3 and J8 (fresh-browser resume, MFP-05b), J4 (the task list,
       MFP-05a), J7 (MFP-06a), J9 and J10 (MFP-09), J11 (MFP-04b).
     J7's pending detail is the most useful line in the output: "GET /api/v1/submissions/:id exists
     and answered, but the job stayed queued for 5s: this runtime mounts no worker (server.js runs
     none), so no assessment is produced". So durable feedback is blocked by COMPOSITION - the runner
     exists and is proven, but nothing runs it - not by the runner being absent.

WHAT THIS MEANS FOR THE QUEUE. Two dispatches move from "planned" to "next, with evidence":
MFP-01 (the checksummed ledger, now confirmed by two independent methods) and MFP-05a (the task list
route, whose consumer J4 already reports PENDING against it). The journey counter gives both of them
a before-and-after number to move.

Base: 36163d8

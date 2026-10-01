You are working in D:\hatoove-work\hd02 on branch codex/hard-delete-02, based on the candidate
origin/codex/ownapi-03-persistent @ e621618.

TASK: read TASK-HARD-DELETE-02.md in full, then read work/implementation/HARD-DELETE-01.md - that
spec is the authority and it contains the eleven-step deletion order. Implement it.

RON'S DECISION, verbatim: "delete is a hard delete."

THE TWO STRUCTURAL FACTS that make a naive deletion impossible, both in the spec:
1. NO ON DELETE CASCADE on any ownership key - the only cascading key in the schema is
   learner_settings.user_id - so DELETE FROM "user" FAILS TODAY.
2. A FOREIGN-KEY CYCLE: submissions references attempts(id, owner_id), and attempts.parent_submission_id
   references submissions(id, owner_id). So the FIRST step is
   UPDATE attempts SET parent_submission_id = NULL - the step most likely to be missed.

THE ACCEPTANCE CHECK THAT PROVES THE TRANSACTION, and the one most likely to be skipped: a forced
failure part-way must leave the account INTACT, not half-deleted. Inject the failure after step 5 and
assert every table still has its rows. The whole deletion runs in ONE transaction.

THE HONESTY REQUIREMENT IS NOT OPTIONAL. A deletion cannot reach the operator's backups, and the
retention window for those is a decision Ron has NOT given. The route's response must STATE what was
not removed. Do not invent a retention policy and do not claim total erasure. SEC-02 already
committed this programme to "deletion is not total, and saying so is part of the fix".

DISCRIMINATION: the new checker must FAIL on e621618 (no deletion route exists) and PASS on your head.
Paste both outputs. This programme has found four checks that passed for the wrong reason - do not add
a fifth.

CRITICAL RULES
- Commit and push after EACH numbered step, SEPARATELY. This rule has saved two runs.
- Run every .mjs checker FROM A FILE. When a check fails, SUSPECT THE CHECK FIRST.
- Baseline must not change (full list in the brief).
- Files must be LF. git diff --cached --check clean before every push.
- Synthetic accounts only. NEVER touch D:\B1_Prep. Use a DISPOSABLE PostgreSQL - these tests delete.
- OPEN A DRAFT PR. A branch with no PR gets no CI.
- If the eleven-step order turns out to be WRONG, STOP and report the corrected order rather than
  inventing a workaround. The spec being wrong is a finding, not a failure.

Report: task id, branch, commit SHA per step, PR URL, base SHA, changed paths, ACTUAL counts, the
discrimination evidence, and explicitly what you could NOT verify - including that the operator-backup
retention question is unanswered by design.
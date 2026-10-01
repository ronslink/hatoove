You are working in D:\hatoove-work\sb02 on branch codex/session-boundary-02, based on
origin/codex/session-boundary-01 @ 521e383 - the branch YOU wrote in the previous slice.

TASK: read TASK-SESSION-BOUNDARY-02.md in full and fix the three defects an independent review
found. It quotes the findings in full; the complete report is at
C:\Users\ronon\.codex\hatoove-handoff\ron-agent\reports\session-boundary-review-hermes-20261001-a\

THE HEADLINE, because it matters for how you read the rest: the review confirmed the two
LOAD-BEARING properties HOLD under deliberate attack - ordering (identity before learner data) and
progress fencing. The hard part worked. What follows are three defects in the claims around it.

- F1 HIGH: sign-out clearing is CONDITIONAL. clearAccountScope({forget: flushed}) where flushed is
  true only if the last save landed within 4s. Offline sign-out, or a save held past 4s, leaves the
  account's notebook/answers/history/ability/settings as PLAINTEXT in localStorage under
  b1prep.state.v1::<accountId>. And session-boundary-browser-check.mjs:372 asserts the property
  UNCONDITIONALLY - so the check names a branch it never exercises. That mismatch is the defect.
- F2 HIGH: a late response DOES land, through the WRITING view. exam.js:757-786, after
  await ai.gradeWriting(...), calls store.recordAttempt and store.addError with no fence. The
  learner's own text ends up in the notebook state that notebookView renders WHILE SIGNED OUT.
  public/js/exam.js is now yours for the writing feedback path ONLY.
- F3 MEDIUM: a new resolve() in the visibilitychange handler re-reconciles the single-user record on
  every tab return and can replace in-memory state mid-session, so "single-user path unchanged" is
  not byte-for-byte.
- F4 LOW: the settings save silently stops sending theme.
- F7: the record cites a base SHA that is not a real object. SECOND time this has happened. Check
  every SHA with `git cat-file -e` before writing it down.

CRITICAL RULES
- Commit and push after F1, after F2, after F3 - SEPARATELY. This rule has already saved two runs.
- Every new check must FAIL on 521e383 and PASS on your head. The reviewer supplied mutants: M3
  fails the F1 check, M7 fails the F2 checks. Use them.
- For F3: do NOT weaken hardening to make a sentence true. Correct the claim instead, precisely.
- Run every .mjs checker FROM A FILE. When a check fails, SUSPECT THE CHECK FIRST.
- Baseline must not change (listed in the brief). reset-check.mjs is 8, not 9 - deliberate.
- Files must be LF. git diff --cached --check clean before every push.
- Synthetic accounts and a stubbed provider ONLY. Never touch D:\B1_Prep.
- CHROME_PATH for browser checks: C:\Program Files\Google\Chrome\Application\chrome.exe

Report at the end: task id, branch, commit SHA per step, PR URL, base SHA, changed paths, ACTUAL
counts, the mutant/discrimination evidence, and an explicit list of what you could NOT verify -
including that the reviewer could not run your two checkers, so that evidence is yours to supply.
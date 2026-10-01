You are working in D:\hatoove-work\sb04 on branch codex/session-boundary-04, based on the candidate
origin/codex/ownapi-03-persistent @ c6bd889.

TASK: read TASK-SESSION-BOUNDARY-04.md in full and implement it. It fixes N-1, a finding from an
independent review, and the brief contains the mechanism already read from the code - use it, do not
re-derive it.

THE MECHANISM, so you know what you are fixing: store.forgetAccountRecords (public/js/store.js:236)
does a ONE-OFF sweep in the tab that ran it. Every OTHER tab still considers itself signed in, holds
the record IN MEMORY, and its debounced write path calls setItem for the account namespace again -
RE-CREATING the key the forget removed, with the learner's text in it. So the forget is not
communicated across tabs and the write path is not fenced against it.

THE FIX NEEDS BOTH HALVES. A durable signed-out marker in localStorage that the write path REFUSES
on, AND a storage-event listener so the other tab actually GOES to the signed-out state. Either
alone is insufficient: a marker without the listener leaves the second tab silently displaying the
previous account's data, which is the same defect class as a late write landing.

THE PRIMARY RISK, named in the brief and worth repeating: the marker must be REMOVED on a successful
sign-in. Getting that wrong turns a privacy fix into a DATA-LOSS bug. The acceptance criteria include
the control that matters most - a fresh sign-in after a forget can still SAVE. Prove it.

CRITICAL RULES
- Commit and push after each numbered step, SEPARATELY. This rule has already saved two runs.
- The new check must FAIL on c6bd889 and pass on your head. Use the reviewer's S7b/S17 reproduction
  from C:\Users\ronon\.codex\hatoove-handoff\ron-agent\reports\session-boundary-02-review-hermes-20261001-a\
- It must drive TWO REAL TABS. A simulated second writer does not test the thing that fails.
- Run every .mjs checker FROM A FILE. When a check fails, SUSPECT THE CHECK FIRST.
- Baseline must not change (listed in the brief). session-boundary-check is 12, browser check is 38.
- Files must be LF. git diff --cached --check clean before every push.
- Synthetic accounts and a stubbed provider ONLY. Never touch D:\B1_Prep.
- CHROME_PATH: C:\Program Files\Google\Chrome\Application\chrome.exe
- OPEN A DRAFT PR. A branch with no PR gets no CI - that already cost a check cycle.
- If the marker half works but the storage-event half cannot be made reliable, STOP at a pushed
  milestone and report that, rather than shipping a marker that leaves the other tab displaying the
  previous learner's data.

Report: task id, branch, commit SHA per step, PR URL, base SHA, changed paths, ACTUAL counts, the
discrimination evidence, and explicitly what you could NOT verify - including that a real phone and a
bfcache restore were not exercised.
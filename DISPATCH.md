You are working in D:\hatoove-work\session-boundary on branch codex/session-boundary-01, based on
origin/codex/ownapi-03-persistent @ 9cccd97.

TASK: read TASK-SESSION-BOUNDARY-01.md in full and implement it. It is issue #63's S4: ONE application
session boundary. Read the issue too where the brief points at it.

CRITICAL RULES
- COMMIT AND PUSH EARLY AND OFTEN. Push the branch after EVERY numbered item in the brief. Two agent
  runs in this programme died late having never committed; that rule exists because of them. A
  deliverable exists only when its commit is on origin.
- Run every .mjs checker FROM A FILE, never node -e with nested quotes.
- When a check fails, SUSPECT THE CHECK FIRST. That has been right repeatedly here.
- Baseline counts must not change (the brief lists them). reset-check.mjs is 8, not 9 - deliberate.
- Files must be LF, not CRLF. git diff --cached --check must be clean before every push.
- Synthetic accounts and a stubbed provider ONLY. No live AI, no real credentials.
- NEVER touch D:\B1_Prep - that is the owner's live install.
- Do not touch public/js/exam.js, server.js, server/accounts.mjs, server/owned-api.mjs,
  server/owned-postgres/**, .github/**, package.json.
- CHROME_PATH for browser checks: C:\Program Files\Google\Chrome\Application\chrome.exe

Start by reading TASK-SESSION-BOUNDARY-01.md, then push an initial commit immediately so the branch
exists on origin, then work item 1, push, item 2, push, and so on. If an item is larger than it
looked, STOP at a green pushed milestone and report what remains rather than dying with nothing
committed.

Report at the end: task id, branch, the commit SHA of each step, PR URL, base SHA, changed paths,
ACTUAL checker counts, discrimination evidence, and an explicit list of what you could NOT verify.
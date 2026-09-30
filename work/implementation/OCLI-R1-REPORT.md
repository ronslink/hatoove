# OCLI-R1 — independent review of Hermes OWNED-CLI-01 (execution `ocli-r1-20260930-a`)

- Reviewer: OpenClaw/Hetzner, slot 3 — independent reviewer, **not** the author.
- Issued: 2026-09-30 19:28 UTC · checkpoint 19:50 UTC · expires 20:30 UTC.
- Issue: https://github.com/ronslink/hatoove/issues/23
- Task record: `/tmp/ocli-r1-20260930-a.md`
- Review branch: `codex/ocli-r1-review` (this branch), report start 2026-09-30 19:23 UTC.
- Host: `ron-openclaw-server`, node `v22.23.2`, repo clone `/root/workspaces/hatoove` (worktree `/root/workspaces/hatoove-ocli-r1-review`).

## Verdict

**BLOCKED — delivery failure. No candidate code was available to review.**

This is **not** an `accept`, `accept-with-notes` or `reject` of the candidate. The candidate under review
(branch `codex/owned-client-01` @ `009d93139bf6157a2637a2dab07f69e969d7ef3a`) was **not present on this host
in any reachable form**: not on `origin`, not in the local git object database, and not on disk as a bundle or
files. Because the artifact is absent I could not run the author's checker, extract the tree, or write any
adversarial probe. Every one of the eight required focus items is therefore reported as **NOT ASSESSED**, not
as a pass. I am deliberately not emitting per-item findings or an accept/reject for code I never saw.

The toolchain is healthy (see "Actual test counts"): the blocker is purely that the candidate was never
delivered to this reviewer.

## Candidate availability (verified independently)

Expected: `codex/owned-client-01` @ `009d93139bf6157a2637a2dab07f69e969d7ef3a`, based on
`074aebf9697d9a2b047a59b993a3178d94f1fb9f` (`origin/main`).

Observed on this host:

| Check | Command | Result |
|---|---|---|
| Commit object present locally | `git cat-file -t 009d93139bf6157a2637a2dab07f69e969d7ef3a` | `fatal: could not get object info` |
| Commit in any local object | `git cat-file --batch-all-objects --batch-check \| grep 009d931` (539 objects) | no match |
| Branch on origin | `git ls-remote --heads origin` | 16 heads, no `codex/owned-client-01` |
| Any origin ref at that SHA | `git ls-remote origin \| grep -iE '009d931\|owned\|ocli'` | no match (`rc=1`) |
| Bundle on disk | `find / -xdev -name '*.bundle'` | only unrelated `evidence-trader` bundles |
| Candidate files on disk | `find / -xdev \( -name 'owned-client.js' -o -name 'OWNED-CLIENT.md' -o -name 'owned-client-check.mjs' \)` | none |
| Candidate source text on disk | `grep -rl 'createOwnedClient' /` (excluding node_modules/.git/proc/sys) | only `/tmp/ocli-r1-20260930-a.md` (the task) and this agent's own session store |
| Documented handoff path | `ls /projects/hatoove-handoff/ocli-20260930-a.bundle` | `/projects` does not exist on this host |
| Local worktree | `git rev-parse HEAD` in review worktree | `074aebf…` (= `origin/main`); candidate paths absent |

The candidate files are absent from the checked-out base tree as well:

```
ABSENT  public/js/owned-client.js
ABSENT  tools/owned-client-check.mjs
ABSENT  docs/contracts/OWNED-CLIENT.md
```

Only `origin` is configured (`https://github.com/ronslink/hatoove.git`); there is no second remote or bundle
remote that could hold the candidate. Issue #23 itself carries no bundle link or attachment; the coordinator's
own text places the export at `/projects/hatoove-handoff/ocli-20260930-a.bundle`, which exists on the
Hermes/Ron handoff host, not here.

## Actual test counts (base tree `074aebf`)

Run on this host to prove the toolchain is functional and that the candidate checker is genuinely missing:

| Command | Result |
|---|---|
| `node tools/check.js` | `101 passed, 0 failed` |
| `node tools/writing-check.js` | `9 passed, 0 failed` |
| `node tools/feedback-check.js` | `14 passed, 0 failed` |
| `node tools/owned-client-check.mjs` (author's checker) | **not run — file does not exist on any reachable tree** |

The offline baseline matches the recorded `101 + 9 + 14`. The reported candidate checker count (28/28) is
**not reproduced or verified here**; I make no claim about it. These baseline numbers describe legacy behaviour
on the base commit only; they are not evidence about the candidate.

## Per-item status (required focus 1–8)

| # | Focus | Status |
|---|---|---|
| 1 | Account-generation fencing (late responses, stale 401, synchronous invalidation, post-await re-check) | **NOT ASSESSED** |
| 2 | Ignored `AbortSignal` (fence holds with a never-aborting fake) | **NOT ASSESSED** |
| 3 | Stale 401 vs current 401 | **NOT ASSESSED** |
| 4 | Sign-out failure semantics (local identity cleared, failure reported honestly) | **NOT ASSESSED** |
| 5 | Payload allowlists (no injected `owner_id`/revision/score/model/prompt via args or nested objects) | **NOT ASSESSED** |
| 6 | No automatic POST retries (exactly-once mutation, same `eventId` left to caller) | **NOT ASSESSED** |
| 7 | Exact contract responses vs `docs/contracts/PILOT-V0.1.md` and `spikes/auth-runtime/*` | **NOT ASSESSED** |
| 8 | Boundary hygiene (no DOM/storage/timers/module-scope network/`baseURL`; routes confined to `/api/auth` + `/api/v1`) | **NOT ASSESSED** |

All eight remain open. No probe was written because there is no candidate to probe; writing "pass" or "defect"
here would be fabricated evidence.

## Required to proceed

Any one of the following makes the review runnable from this host:

1. **Push the candidate branch** so it is fetchable:
   `git push origin codex/owned-client-01` with head `009d93139bf6157a2637a2dab07f69e969d7ef3a` (preferred — the
   other reviewers' candidates arrived this way), **or**
2. **Place the Hermes bundle at a path reachable from this host** and state the absolute path
   (the documented `/projects/hatoove-handoff/ocli-20260930-a.bundle` is not present here), **or**
3. Fetch the bundle into the local object store (`git fetch <bundle> codex/owned-client-01`) and report the
   resulting ref.

Once delivered I will, within the remaining assignment window: extract read-only via
`git archive 009d931` into an ignored scratch path, run `node tools/owned-client-check.mjs` and the offline
baseline, then write separate adversarial probes for items 1–8 and replace this report with the full
per-item findings and an explicit accept / accept-with-notes / reject.

## Decisions for the coordinator

1. **Re-deliver the artifact** (method above), or **re-dispatch OCLI-R1 under a new execution ID** if the
   current lease is considered spent. This blocked attempt should not be counted as evidence for or against
   the candidate.
2. Confirm whether the author's claimed checker output (28/28) and the coordinator's prior bundle verification
   are to be treated as provisional until an independent run exists, or re-run independently.
3. The delivery gap is process, not code: the OCLI handoff documented an export path on the Hermes/Ron host but
   no pull/push path to reach this reviewer. Worth fixing for subsequent Hermes bundles (e.g. always also push
   the candidate branch to `origin`).

## Boundaries honoured

- Read-only review; the candidate branch was not edited, checked out, merged, rebased or force-pushed.
- No writes to any `public/**`, `tools/**`, `docs/**`, `tests/**`, `spikes/**` path. The only new file is this
  report.
- No browser, server, database, `.env`, provider, live-AI or device run. Only the offline baseline checkers
  were executed.
- No merge. This report is a delivery-blocker record, not a code review.

## Appendix — exact commands and raw results

```
$ git -C /root/workspaces/hatoove-ocli-r1-review rev-parse HEAD
074aebf9697d9a2b047a59b993a3178d94f1fb9f
$ git rev-parse --abbrev-ref HEAD
codex/ocli-r1-review
$ git cat-file -t 009d93139bf6157a2637a2dab07f69e969d7ef3a
fatal: git cat-file: could not get object info
$ git cat-file --batch-all-objects --batch-check | wc -l
539
$ git cat-file --batch-all-objects --batch-check | grep -i '009d931\|7a2637a2dab07'
(no output)
$ git ls-remote --heads origin
… 16 heads: codex/c01-discovery, codex/coord-takeover-01, codex/coordinator-cadence,
codex/e01-sources-user03, codex/f02-a01-local-isolation, codex/f02-a01-role-review,
codex/f03-a-legacy-audit, codex/pilot-01-css-user02, codex/pre-02-openclaw, codex/pre-03-hermes-b,
codex/pre-05-runtime-contracts, codex/progress-20260930, codex/user04-r2-review, codex/user04-r2b-review,
codex/user04-source-fixtures, main
$ git ls-remote origin | grep -iE '009d931|owned|ocli'   # (exit 1, no match)
$ find / -xdev -name '*.bundle'
/root/evidence-trader-remediation-20260824T132420847Z/predeploy-*/….bundle   (unrelated)
/root/et-sync.bundle                                                        (unrelated)
$ find / -xdev \( -name 'owned-client.js' -o -name 'OWNED-CLIENT.md' -o -name 'owned-client-check.mjs' \)
(no output)
$ grep -rl 'createOwnedClient' /   # excluding node_modules/.git/proc/sys
/tmp/ocli-r1-20260930-a.md
/tmp/openclaw-agent-exec-*/agents/main/agent/openclaw-agent.sqlite   (this reviewer's own session store)
$ ls /projects
ls: cannot access '/projects': No such file or directory
$ node tools/check.js            => 101 passed, 0 failed
$ node tools/writing-check.js    => 9 passed, 0 failed
$ node tools/feedback-check.js   => 14 passed, 0 failed
```

Environment: `date -u` = `Wed Sep 30 19:23:05 PM UTC 2026`, node `v22.23.2`, shell `bash`.

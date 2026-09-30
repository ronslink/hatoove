# Hatoove master plan — delivery tracker

**Owner:** coordinator (`COORD-TAKEOVER-20260930`, issue [#27](https://github.com/ronslink/hatoove/issues/27))
**Last updated:** 2026-09-30 19:25 UTC · **Base:** `origin/main` @ `074aebf`
**Update cadence:** with `work/BOARD.md` and `IMPLEMENTATION_PLAN.md` after meaningful transitions.

This is the **single consolidated progress tracker** for the programme. Read it first, then go to the
authoritative source for detail.

## Where the authoritative detail lives

| Question | Authoritative record |
|---|---|
| Which packages exist and their acceptance criteria? | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — the 36 packages, milestones and gates |
| What is running right now, on which slot and lease? | [`work/BOARD.md`](work/BOARD.md) — live slot table |
| What is authorized next? | coordinator handoff `QUEUE.md` (12 ordered workstreams) |
| What is the current coordination status? | coordinator handoff `CURRENT.md` |
| Handoff folder (outside the repo; communication files only) | `<user-home>/.codex/hatoove-handoff/ron-agent/` |
| Why is the product built this way? | [`PILOT_BUILD_PLAN.md`](PILOT_BUILD_PLAN.md) |
| How do agents/hosts/handoffs work? | [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md), [`docs/AGENT_RUNBOOK.md`](docs/AGENT_RUNBOOK.md) |

If this tracker and `IMPLEMENTATION_PLAN.md` disagree, **the plan wins** — this file is a summary and may lag.

## Status legend

`planned` → `in progress` → `delivered` → `independently reviewed` → `green CI` → `merged` → `accepted`

**These are not synonyms.** A passing test count means *internal shape only*; it is not exam validity,
security, accessibility or product acceptance. Delivered ≠ reviewed ≠ merged ≠ accepted. Human gates
(exam/content/language/security/legal) are separate from all of the above.

## Programme objective

A dependable, mobile-capable **internal learner journey** in the existing `public/` app's visual style:
account/exam/date/language setup → owned attempt/task identity and draft → submission with pending, failed or
unassessed feedback → return, revision and second device → honest objective practice with fixed, reviewed
audio. **Speaking/STT is outside the pilot.** Preserve the navy/orange Hatoove identity; no framework
migration, no hosting change.

## Closed milestones (merged, with evidence)

| Slice | Merge | Evidence |
|---|---|---|
| F-01 baseline, source guard, Linux/Windows CI | — | 124-check baseline recorded |
| Worker capability: OpenClaw Git handoff, Hermes bundle handoff, one bounded Hermes child | #3, #4, #6 | PRE-02/03/06 exercises |
| F-03 auth/runtime + pilot contracts | #11 `a9a4cfd` | 12 scenarios / 13 runner checks |
| F-02/A-01 local SQL least-privilege isolation | #18 `a58f6fb` | 10 scenarios / 11 runner checks; four runtime/bootstrap roles, immutable submissions, atomic enqueue, one debit after saved assessment, deletion tombstones |
| F-04 / PILOT-01 CSS bounding | #12 `bb30267` | **Only D5/D6 reproduced and changed.** D2/D3/D8 were false positives; 200% zoom filenames unreliable as proof |
| C-01 discovery | #20 `a9ed166` | `7e24229`: 24 sets / 180 slots / 6 writing prompts, **0 tracked fixed audio**, rights/review unknown |
| Master-plan alignment | #22 `074aebf` | plan + board + discovery |

## Workstream tracker (12 items from the coordinator handoff)

| # | Workstream | State | Evidence / blocker | Next action |
|---|---|---|---|---|
| 1 | **Takeover and reconcile live work** | **delivered** | ACK + checkpoint written; origin/main and both remote processes verified; coordinator established in AGENTS/workflow/runbook/board/plan via PR | Independent review of this coordination PR |
| 2 | **Finish USER04 acceptance; integrate source/fixture stack** | **in progress** | USER04 stack `cba0f0c` delivered + self-checked (**127 tests**), 20 review corrections applied. PR26's verdicts are **stale** (`562902b`). OpenClaw `user04r2b` reviewing `cba0f0c` now | Await independent verdict; then build one integration candidate from `origin/main` carrying both PR17 and PR21 corrections — never the known-broken intermediate tree |
| 3 | **Accept and integrate Hermes owned API client** | **delivered, awaiting review** | Bundle `009d931`; coordinator verified exactly the 3 allowed paths, `git bundle verify`, its checker **28/28**, baseline **101+9+14** on the returned tree, clean boundaries | Dispatch independent review (account-generation fencing, ignored AbortSignal, stale vs current 401, sign-out failure, payload allowlists, no automatic POST retries) |
| 4 | **Truthful mock outcomes** | **planned — paused code preserved** | issue #25; `codex/writing-outcomes-01` @ `074aebf` holds an **incomplete, untested** exam.js diff + `mock-outcome.js`. `renderMockResult` still assumes the old score shape | Adopt as a fresh bounded execution with **exactly one `exam.js` writer**; complete unassessed-writing behaviour, remove heuristic mark/pass claim/grade band |
| 5 | **Account-scoped draft state** | **planned** | No module yet | Record the versioned decision against contract 0.1.0 first; then `owned-draft.js` + checker + contract doc. **No `exam.js` writer until this boundary is accepted** |
| 6 | **Connect writing UI to durable attempts/drafts** | **blocked on 5** | `public/js/exam.js` reserved | Serialise behind workstream 5 |
| 7 | **Account/session entry flow + browser-to-server fixture** | **planned** | Runtime spike exists but is not production-deployed | Scope to separate assigned files; keep `exam.js` exclusive; synthetic loopback server, ephemeral secrets |
| 8 | **Durable submission/result/retry/revision UI** | **planned** | Server contract already proves idempotency, lease fencing, one debit | Serialise behind 6; use provider stubs |
| 9 | **Server-side objective marking** | **planned** | Fixtures prepared in USER04 (36 cases; not yet accepted) | Assign a pure authoritative-marking slice **only after** fixture acceptance; keep private keys out of learner payloads |
| 10 | **Fixed-audio delivery + content provenance** | **planned** | Discovery reports **0 tracked fixed audio**; rights unknown | Asset manifest/schema + local delivery fixture with synthetic/licensed audio only |
| 11 | **Independently verify the internal learner journey** | **blocked on 5–8** | — | Fresh synthetic checkout, isolated ports; record real-device checks as **pending**, never passing-by-emulation |
| 12 | **Close plan gaps; prepare next bounded batch** | **ongoing** | — | Update plan/board states with links; keep human/device gates visible |

## Open review and integration queue

| PR | Content | State | Action |
|---|---|---|---|
| #17 | USER-03 source register + blueprint checker | open, draft | Fold into the integration candidate after review |
| #21 | USER-04 fixture/checker stack @ `cba0f0c` | open, draft (stacked on #17) | Accept via `user04r2b`; then integrate both sequences together |
| #26 | PR26 review report @ `562902b` | open, draft | **Stale** — superseded by `user04r2b`; keep as history |
| coordination PR | Coordinator transfer records | open | Independent review |

## Human and device gates (open — no agent may close these)

- **Educational/exam fidelity** (E-01): requires qualified expert signoff; the source register is unreviewed.
- **Content and audio rights**: public availability is *not* permission to copy. Audio review (C-04) unfulfilled.
- **Native-language explanations** (C-06): none reviewed.
- **Writing feedback**: provisional/formative. Never calibrated readiness, never a whole-exam pass — the oral
  part is unassessed, so no overall result may be computed.
- **Real devices**: iPhone Safari and Android Chrome keyboard/audio/tab-discard/process-kill evidence is
  **pending**. Viewport emulation cannot close it.
- **Security/privacy/legal** (X-01, P-03): open.

## Boundaries in force

No production publication, deployment, DNS, live payments, new production access, invitations or live AI
evaluations. Provider stubs and synthetic progress only. Browser checks only on a source-only disposable
checkout with isolated ports and **no `.env`**. No learner records, credentials, raw provider logs, browser
profiles, machine config, bundles or agent memory in commits. Source guard + `git diff --cached --check`
before each push, staged names inspected. Baseline `101 + 9 + 14` is historical until rerun — report actual
counts. No hosting or framework migration.

## Concurrency

Global cap **4 active agents** including the coordinator, all parents, children and reviewers. Default
allocation: coordinator + Hermes + OpenClaw + at most one independent reviewer. No recursive spawning. **A
reviewer must not be the author of the slice under review.**

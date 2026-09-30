# Hatoove master plan — delivery tracker

**Owner:** coordinator (`COORD-TAKEOVER-20260930`, issue [#27](https://github.com/ronslink/hatoove/issues/27))
**Last updated:** 2026-10-01 · **Base:** `origin/main` @ `5a63429949275f4cb27cd7f64565afe8cf029511`
**Update cadence:** with `work/BOARD.md` and `IMPLEMENTATION_PLAN.md` after meaningful transitions.
**Dispatch mechanics:** the per-worker setup, delivery and verification facts live in the coordinator handoff
folder's `WORKSPACE-SETUP.md` (recorded 2026-10-01) so a handoff stops re-deriving them.

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
| Integration stack (USER-03 + USER-04) | #35 `82ae9c2` | 13 files added, 6589 insertions, **0 deletions** — a real three-way merge, not a hand rebuild. PR #33 (hand rebuild) rejected by independent review and retained as the rejection record |
| F-1 origin/authorization gate | #38 `9c57ffd` | `server-origin-check.mjs` 16/16; the reviewer's own probe showed pre-fix `82ae9c2` returned 200 **and rewrote the env file**, fixed head returns 403 `origin_rejected`; 14 bypass classes, 78 assertions, zero bypasses |
| Owned client transport | #41 `de4ecb6` | `owned-client-check.mjs` **31/31**; generation fencing holds even when the transport ignores `AbortSignal` |
| F-2 reset actually deletes | #42 `675a3f6` | `reset-check.mjs` 9/9; independent review then found the **in-flight-save race** |
| F-3 AI disclosure | #44 `0ee7e13` | learner-facing copy; flagged for human C-06 review |
| SEC-02 race correction | #45 `258f200`… | `progressEqual` compared `JSON.stringify` against a differently-ordered `mergeProgress` output, so identical records compared unequal and the server shipped a full payload on **every** POST |
| F-2 race: revision fence | #47 `8a71f71` | `revision-check.mjs` **8/8 including pre-fix discrimination**; a `DELETE` now invalidates older in-flight writes with `409 stale_revision` |
| OWNAPI-01 owned API | #48 `2974359` | `owned-api-check.mjs` **24/24** driven by the real client over real HTTP |
| F-7 key exposure | #50 `616e1e5` | `keymask-check.mjs` **12/12**; pre-fix disclosed exactly **5 runs of ≥3 key characters**, fixed discloses none |
| F-8 account name | #46 `fa53e30` | machine paths and OS account name removed from tracked docs |
| PM-01 `progressEqual` | #49 `2f892d2` | `progress-equal-check.mjs` **10/10** with pre-fix discrimination |
| **DRAFT-SESSION-01 draft service** | **#51 `c8bf97a`** | 4 files added, **0 deletions**, `exam.js` byte-identical; checker **17/17**, tests **21/21**; **independent review: accept-with-notes, no blocking defect** |
| **OWNAPI-02 PostgreSQL adapter + RLS evidence** | **#52 `5a63429`** | own package scope (`pg` 8.23.1) so the root app stays dependency-free; coordinator ran the proof on real PostgreSQL — **6/6** isolation tests and **24/24** the same suite on the pg backend; **discrimination proven by mutation** (granting the learner role `BYPASSRLS` makes it fail with "leaked a cross-owner row") |

## Workstream tracker (12 items from the coordinator handoff)

| # | Workstream | State | Evidence / blocker | Next action |
|---|---|---|---|---|
| 1 | **Takeover and reconcile live work** | **merged** | `41b5efb` (PR #29) | — |
| 2 | **Finish USER04 acceptance; integrate source/fixture stack** | **merged** | Integration stack `82ae9c2`; the hand-refusal (#33) is retained as the rejection record | Independent review of the accepted stack's known guard limits (`rationale`/top-level/family gaps) is documented, not closed |
| 3 | **Accept and integrate Hermes owned API client** | **merged** | `de4ecb6` (31/31) and the owned API `2974359` (24/24) | — |
| 4 | **Truthful mock outcomes** | **delivered twice, under independent review** | Two complete implementations exist: **#53** `72994ad` (16/16 checker, 20/20 tests, browser check cannot run unattended) and **#54** `793f3c6` (19/19, 21/21, self-contained browser proof **11/11**, plus a restart-button defect fix). Measured comparison published on `origin/codex/wo02-impl-compare` | **Hermes `wo02-verify-hermes-20261001-a` is adjudicating and verifying now.** Merge waits on that verdict; #53 would then be closed as superseded |
| 5 | **Account-scoped draft state** | **delivered, merged** | `public/js/draft-session.js` in `c8bf97a`; IDs only, keyed by account+task, never learner text; reviewer found one **non-blocking** discriminator gap (the module's own generation fence is redundancy today, not an independently proven control) | Wire it into the app (workstream 6) once Ron releases `exam.js` |
| 6 | **Connect writing UI to durable attempts/drafts** | **blocked on Ron's `exam.js` release** | The original hold is gone (the paused `writing-outcomes-01` no longer owns the file — WRITING-OUTCOMES-02 rewrote it), so the hold now means only "no second concurrent writer" | Confirm release, then wire `draft-session.js` in as its own bounded slice |
| 7 | **Account/session entry flow + browser-to-server fixture** | **planned** | The owned client and owned API are both merged, but **nothing in `public/**` calls them** — the audit's premise correction still stands | Next product slice after 6; synthetic loopback server, ephemeral secrets |
| 8 | **Durable submission/result/retry/revision UI** | **planned** | Server contract already proves idempotency, lease fencing, one debit | Serialise behind 6 and 7; provider stubs |
| 9 | **Server-side objective marking** | **planned** | Fixtures prepared (36 cases); **no authoritative marking implemented** | Bounded slice after 6; keep private keys out of learner payloads |
| 10 | **Fixed-audio delivery + content provenance** | **planned** | Discovery reports **0 tracked fixed audio**; rights unknown | Asset manifest/schema + local delivery fixture with synthetic/licensed audio only |
| 11 | **Independently verify the internal learner journey** | **blocked on 6–8** | — | Fresh synthetic checkout, isolated ports; real-device evidence stays **pending**, never passing-by-emulation |
| 12 | **Close plan gaps; prepare next bounded batch** | **ongoing** | Baseline `101 / 9 / 14` plus checkers 16 · 9 · 8 · 31 · 24 · 12 · 10 · 17 re-measured 2026-10-01 | **Wire the ungated checkers into CI** (`ci-gates-01-claude-20261001-a` running); F-4 (`f4-scope-01` OpenClaw) and F-5 (`f5-deletion-01` Clawdbot) running |

## Open review and integration queue

| PR | Content | State | Action |
|---|---|---|---|
| #54 | WRITING-OUTCOMES-02 implementation B @ `793f3c6` | open, draft | **Awaiting Hermes's independent verdict and adjudication**; the author must not review it |
| #53 | WRITING-OUTCOMES-02 implementation A @ `72994ad` | open, draft | Close as superseded if the reviewer confirms B |
| #33 | Hand-rebuilt integration stack @ `7f1ffd7` | open, draft | **Do not merge.** Retained as the record of the rejection; review is #34 |

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

**Ron authorised all four workers (Hermes, OpenClaw, Clawdbot, Claude) plus the coordinator on 2026-09-30**, which
supersedes the earlier "four including the coordinator" reading. A reviewer occupies the reviewer role; it does
not add a fifth worker. No recursive spawning. **A reviewer must not be the author of the slice under review.**

## Verification gaps recorded, not closed

1. **Five checkers were ungated by CI** (`revision`, `keymask`, `progress-equal`, `draft-session`, `owned-api`)
   because `.github/**` had never been in a worker's allowed paths. `ci-gates-01-claude-20261001-a` is fixing it.
2. **`reset-check.mjs --legacy-root` with no value silently compares the candidate against itself** and reports a
   false negative. Never wire it into CI without a real path.
3. **The `draft-session` checker does not discriminate the module's own generation/account fence** — deleting the
   guard still yields 17/17 (verified by independent mutation). Correct in shipped code; **redundancy today, not a
   proven control.**
4. **`owned-api-pg-check` is now gated in CI** and was executed locally on real PostgreSQL; the mutation proving
   it fails under `BYPASSRLS` was run by the coordinator, not by an independent reviewer.

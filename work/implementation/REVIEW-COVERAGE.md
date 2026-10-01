# REVIEW-COVERAGE — what each independent review actually covered, at `e126d8c`

| | |
|---|---|
| Why | an independent audit's **first priority**: *"the coordinator should map their coverage to the final combined head, including the later session/deletion changes, and record the integration decision."* This is that mapping. **It is not a merge approval** |
| Candidate | `codex/ownapi-03-persistent` @ `e126d8c` |
| `main` | `4f76b94` — **untouched.** Nothing merged into the candidate has reached `main` |
| **STATUS — updated 2026-10-01, after the reviews this document asked for** | **The condition this document set has been MET, and the answer is still NO.** Three independent readers were dispatched against `e126d8c`: both safety slices this document names as never-reviewed, and the combined head. Their reports are in `reports/review-deletion-e126d8c/`, `reports/review-fence-e126d8c/` and `reports/review-head-e126d8c/`. **Between them they found four HIGH and three MEDIUM defects in slices that had passed every check in the tree.** The full re-execution of this head — every CI suite on a fresh disposable PostgreSQL and in headless Chrome — plus the reconciliation and the merge limitation are in **`COORD-REEXECUTION-e126d8c.md`**. **Read its §5 and §7 before proposing anything.** |

## The finding, stated plainly

**No review covers the current head.** Measured with `git rev-list --count <reviewed>..HEAD`:

| Review | Reviewed head | Commits landed after | Files landed after |
|---|---|---|---|
| `platform-review-hermes-20261001-a` | `90d9860` | **60** | 35 |
| `saas-runtime-review-hermes-20261001-a` | `c5ce81b` | **54** | 34 |
| `session-boundary-review-hermes-20261001-a` | `521e383` | **47** | 38 |
| `session-boundary-02-review-hermes-20261001-a` | `96b11fb` | **42** | 37 |

**The most recent review is 42 commits and 37 files behind.** Every one of the four was sound for the head it
examined; **none of that evidence transfers automatically to `e126d8c`.** That is the whole point of the mapping,
and it is why "four reviews passed" is not by itself a merge argument.

## The seven production files that landed AFTER the last review

Classified from `git diff --name-only 96b11fb..e126d8c`. Checkers, CI and records changed too, but these are the
files that carry behaviour:

| File | What changed | Independently reviewed? |
|---|---|---|
| `server/owned-api.mjs` | the `DELETE /api/v1/account` route (D3) | **NO** |
| `server/owned-postgres/adapter.mjs` | the eleven-step deletion transaction and the `afterStep` hook (D3) | **NO** |
| `public/js/account.js` | the session boundary, then the N-2 discard notice, then the N-1 cross-tab fence | **NO at this head** — the boundary was reviewed at `521e383`; **N-2 and N-1 landed after** |
| `public/js/store.js` | the N-1 signed-out marker and the write-path refusal | **NO** |
| `public/js/app.js` | the boundary wiring | **NO at this head** |
| `server.js` | the hosted-mode refusals and the saas-runtime work | **reviewed at `c5ce81b`, 54 commits behind** |
| `server/accounts.mjs` | the deletion port wiring | **NO** |

**So the honest position is: the two slices whose whole claim is safety — account deletion, and the cross-tab
sign-out fence — have never been independently reviewed at any head.** Both were verified by a checker that the
coordinator ran, and both of those checkers were themselves written by the worker whose code they test. That is
precisely the arrangement that produced five defects earlier in this programme, three of which only an independent
reader found.

## What IS covered, and where the evidence still holds

| Area | Evidence | Still valid at `e126d8c`? |
|---|---|---|
| Persistent PostgreSQL install, RLS, roles | `postgres-provision-check` 5/5, now **gated in CI** | **Yes** — the code is unchanged since, and the CI job runs it on every push |
| Account API over real HTTP, restart property | `accounts-http-check` 6/6, **gated in CI** | **Yes**, same reasoning |
| Owned API contract, client contract | `owned-api-check` 24/24, `owned-client-check` 31/31, **gated in CI** | **Yes** |
| Provider is operator-only and invisible | `provider-config-check` 11/11 + browser 13/13, **both gated** | **Yes** |
| Design language, language-setting guard | `design-check` 11/11, **gated** | **Yes** |
| Session boundary ordering and progress fencing | reviewer's own 30-row probe, 30/30 at `521e383` | **partially** — ordering and fencing code is unchanged, but `account.js` has since been edited for N-1/N-2, so the *file* is not the reviewed artifact |
| Runtime refusals (S1/S2) | reviewer's independent attack at `c5ce81b` | **partially** — `server.js` has 54 commits of change on top, though the refusal lines themselves were not edited by them |

**The distinction that matters:** CI now re-runs the *behaviour* on every push, which is stronger than a one-off
review for regression. **A review is still the only thing that asks whether the check tests the right thing** — and
these checkers were written by the same author as the code they check.

## The integration decision, recorded as the audit asked

**Not merged, and not proposed for merge until the two unreviewed safety slices have an independent reader.**
Specifically:

1. **Review `hard-delete-02`'s code** (`owned-api.mjs`, `adapter.mjs`) at a head containing it. The checker is
   strong — read-back as superuser with RLS bypassed, cross-account counted row by row, and forced-failure at both
   the route and the adapter — but **the author of the deletion also wrote the test of the deletion.**
2. **Review the N-1 cross-tab fence** (`store.js`, `account.js`), for the same reason. N-1's own check was written
   after the reviewer *found* N-1, so the reviewer has never seen the fix.
3. **Then** reconcile: either re-review the combined head, or record explicitly which findings are known-good by
   re-execution rather than by reading, and **state that limitation in the merge decision**.

This is deliberately slower than merging. The audit said it is *"not a blanket merge approval"*, and the coverage
map above is the reason to agree.

## The condition was met, and the answer survived it — recorded 2026-10-01

All three items above were carried out. **Do not read the completion of this list as a merge approval**; read the
result:

1. **`hard-delete-02`'s code was reviewed independently** (`reports/review-deletion-e126d8c/report.md`). The reviewer
   tried to break the eleven-step transaction and the route's owner derivation and **failed** — and then found the
   slice **does not delete anything in any configuration this repository can ship**: `accountDeletion` is passed at
   exactly two call sites and both are inside the author's own checker, so the running server answers
   `503 deletion_unavailable` forever. It also found that **no provisioned role can run the deletion**, so the fix to
   the first finding alone produces a `500`. **F1 and F2 HIGH, F3 HIGH (a checker failure mode that is a second
   throw, not the silent partial delete it claims).**
2. **The N-1 cross-tab fence was reviewed independently** (`reports/review-fence-e126d8c/report.md`). The fence
   itself is **sound** — the reviewer attacked it with a second module instance, an interleaved flush, a reload, a
   missing marker, an unreadable marker, a refused marker write, a same-page switch and a signed-out page, and it
   held. **The slice around it is not:** a late mock-test answer **crosses into the next account's record**
   (`F-A`, HIGH), and a browser that **never signed in** is **permanently locked out of its own local record** by a
   transient `500` (`F-C`, HIGH).
3. **The combined head was re-executed in full** (`COORD-REEXECUTION-e126d8c.md`), and a third reader was dispatched
   at the combined head (`reports/review-head-e126d8c/`) for the finding-by-finding reconciliation. **Nine of the
   findings that made this head unreviewed are now correct by execution; one is only partly covered; three lows are
   open.** The re-execution also found that **`owned-api-check --backend=postgres-persistent` prints the memory
   note**, so the CI job that proves the durable property tells its reader it proved nothing.

**The merge condition therefore moves, it does not clear.** The reviews did their job, which is exactly why this
document exists. See `COORD-REEXECUTION-e126d8c.md` §7 for the five conditions that now precede a merge proposal.
`main` remains `4f76b94`.

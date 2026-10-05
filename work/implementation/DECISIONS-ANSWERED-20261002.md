# Decisions answered — 2 October 2026 (Ron)

Recorded verbatim in substance, with what each one unblocks. Where Ron's answer and the earlier recommendation
differ, his answer wins and the difference is stated rather than smoothed over. `DECISIONS-RECOMMENDATIONS.md`
is now a HISTORICAL document: its recommendations were written before these answers and no longer govern.

| # | Decision | Answer (Ron, 2 Oct 2026) | What it unblocks |
|---|---|---|---|
| **D1** | Content rights | **The content is AI-generated.** See [CONTENT-RIGHTS-D1.md](CONTENT-RIGHTS-D1.md) for the per-source record: the repository holds a source path for each of the four sources and **no author anywhere**, so the basis recorded is `generated` rather than `unknown` | The `rights_status='generated'` migration + serving-policy value; the pool can serve generated content while still refusing hand-authored material with no basis. Removes the only item that blocked serving content in production |
| **D5** | Auth library | **Harden the existing session port; do not adopt Better Auth now** (the four behaviours were built in round 17 behind the port seam). Hashing parameters and RLS grants remain a **human security signoff** if the library is ever adopted | Nothing pending: the four behaviours are implemented and gated by `session-lifecycle-check` (6 legs) |
| **D6** | Email provider | **Operator-assisted reset** (built, round 19) — **and use the honest pilot wording** on the UI | The recovery UI can now be written: it must say that a person sends the link, not that an email was sent |
| **D8** | Audio / speech | **Browser voice for on-screen text.** Listening needs **commissioned native recordings** — which will use **AI, later** | The Hören view stays honestly unavailable until recordings exist; the `audio` field in the `objective_set` contract is the next step when they do |
| **D9** | Second exam package | **telc B1 only**; **original items, never a board's item bank**; **consider telc English B1** as the second package | The ADR can be written with the candidate named; the `exam_id` abstraction is already in place |
| **D10** | Live model calls | **AMENDED 5 Oct 2026 by Ron:** AI is **no longer forbidden** — *"we need to be careful; in this case it’s fine"*. Offline AI generation of **content assets** (e.g. the three new listening recordings by TTS) is authorized now, with provenance recorded and human review still required before anything is marked reviewed. A **live in-product call to a real learner** is no longer banned in principle but stays a per-feature decision with its cost, privacy and quality care named in that feature’s record | TTS recordings may be produced for POOL-01 batch 1; the stub grader stays the shipped grader until a live call is separately decided |
| **D12** | Fill policy | **Batch refill below threshold, with a budget cap** | The pool's deficit loop gets its policy: batch, threshold-triggered, budget-capped |
| **D13** | Reviewer + pool sizes | **A telc-licensed B1 examiner / DaF teacher will be engaged (name to follow)**; pool sizes and review modes **as recommended**; **real filling waits for D10** | E-01 gets its reviewer; pool targets come from `CONTENT-POOL-01.md`'s recommendation |
| **D14** | Entitlement / pricing | **Per-exam prep with a term, priced per market; the pilot is free with a configured allowance** — *the "free with a configured allowance" half is **superseded by D15** (3 October 2026): the pilot sells through Stripe* | The entitlement model keeps its configured allowance **and gains a term**; the checkout screen is in scope |
| **R15** | Score contract | **Grades only, no total** | The band contract stands as built (no numbers stored); the /45 total stays unbuilt and unshown, and the UI's "no total" rule is now a decision rather than a default |
| **E-01** | Rubric accuracy | **Reviewer to be engaged (D13)**; the rubric's provisional labelling stays until then | The rubric stays `unreviewed` and the screen keeps saying so; the descriptors are written for this product and are not telc's published text |
| **Tab bar** | Navigation | **Five plus "Mehr"** | A UI change: four primary destinations plus a "Mehr" overflow, replacing the current ten-link scrolling row |
| **Landing page** | Language | **German** | The front door is German; no language switcher on it |
| **Sentence building** | The missing corpus | **Recover `satzbau.js` as a server check, and the `generators.js` drill banks as content** | Both files exist in git history (deleted in `39125a9`, SPA-RETIRE 4) — recoverable with `git show 2feaba6:public/js/satzbau.js` and the equivalent for `generators.js` || **Leftovers** | Single-user handlers | **Delete them** | The old file handlers in `server.js` reachable when `B1PREP_SAAS` is unset go away, with `retired-surface-check` extended to prove they cannot come back |

## The work this creates, in the order it should be done

1. **Delete the single-user file handlers** and extend `retired-surface-check` to hold the line. Small, and it
   removes a live surface that the decision explicitly closes.
2. **`rights_status='generated'`** — the migration and the serving-policy value, so generated content can be
   served and hand-authored material with no basis still cannot. This is D1's implementation.
3. **Recover `satzbau.js` as a server check** and **`generators.js` drill banks as content** — the sentence
   building item, which the queue could not resolve without this instruction. **Recoverability verified by
   execution:** `39125a9~1:public/js/satzbau.js` is 16,545 characters and `39125a9~1:public/js/generators.js`
   is 46,148 characters, both present in the object store. They are NOT in the working tree.
4. **The tab bar: five plus "Mehr"**, with desktop/mobile and light/dark evidence for the change.
5. **The recovery + verification UI** — "Passwort vergessen?" on the sign-in screen, the reset and verification
   pages — with wording that says a person sends the link.
6. **D12's batch refill** with its budget cap, below threshold, once D10's three gates exist.
7. **D9's ADR**, naming telc English B1 as the candidate and stating the original-items rule.

**Still human, unchanged by these answers:** the named reviewer (D13/E-01), the hashing/RLS signoff if Better
Auth is ever adopted, the privacy/DPA review and cost cap (D10), the commissioned recordings (D8), and the
price/market/VAT/refunds detail behind D14.

# Complete public DTZ admission — 3 October 2026

Execution **EXAM-S6-20261003-A**, [issue119](https://github.com/ronslink/hatoove/issues/119), contract [EXAM-S6](../../docs/contracts/EXAM-S6.md). Runtime candidate `7b3438ac3092bcaebc7b1bd44cf5e121cc2f757b`, based on independently reviewed S5 `d31a763`. Engineering is delivered, independently reviewed and locally verified. Hosted CI and integration remain separate; the dependency PRs are still open behind the GitHub account billing/spending block.

## Delivered behavior

- One restricted SQL eligibility decision admits public DTZ only when the current available release contains a usable complete written form: exact listening/reading counts, A/B writing, fixed time groups, playback rules, approved versions and permitted effective rights. The default deployment remains telc-only; explicit internal preview supports the existing partial fixtures.
- Discovery, new preparations, objective practice, standalone writing, new mocks, offers and new orders share that decision. No caller-supplied policy can widen it. Owner locks precede exam locks, and publication/rights changes serialize against committing admissions.
- Existing preparations, pinned runs, writing revisions, saved answers, exact receipts, unchanged pending orders and webhook grants retain their continuation rules. An explicit rights block withholds protected material while preserving owned identity and responses.
- Restricted SQL guards reject forged continuation exemptions. Payment roles receive minimal eligibility metadata without content-table reads or new mutation privileges.
- SQL validates objective payloads against the canonical reader's identifiers, allowed fields, protected-key exclusions, text bounds, UTF-16 lengths and ECMAScript whitespace rules. A malformed optional form cannot hide another valid complete form.

## Independent review and corrections

The core, learner admission, payments and integration changes had separate authors and reviewers. Root's shared synthetic fixture was independently checked to reject a mismatched actual database schema before any simulated review operation.

Review reproduced a same-owner objective/writing deadlock in the first admission implementation. Correction `4464b21` acquires the owner before the exam; two real separate-connection tests and the original failing schedule now pass. Historical upgrade fixtures were corrected in `b628dec` to create old rows through the SQL available before migration0034.

Review also reproduced SQL eligibility accepting malformed payloads that the form reader refused. Correction `3529d45`, adopted as `a5065ef`, closes those mismatches. Ron explicitly approved the prepared migration correction and disposable tests after automatic approval review requested exact authorization. The independent reviewer reran the tracked suite and restored only the original predicate inside a disposable fixture: the new test then failed at the conflicting item alias, proving that it detects the original defect. The migration's raw hash matches its manifest. No earlier migration was edited.

## Executed evidence

| Scope | Evidence |
|---|---|
| Policy wrapper | 9 checks |
| Core SQL, grants, lineage and forward preservation | 16 PostgreSQL checks, independently rerun on the correction |
| Canonical payload parity and helper authority | 81 checks, independently rerun; old-predicate discriminator fails as expected |
| Learner admissions, direct IDs, continuations and real concurrency | 12 PostgreSQL checks on the integrated correction |
| Offers, stub checkout, receipt/term preservation and both rights orderings | 16 PostgreSQL checks on the integrated correction |
| Public browser journey | 7/7 on matching corrected runtime/browser/registry source |
| Retained upgrade/runtime checks during integration | S3 reading10, S4 writing17, media19; complete-mock backend16, worker13 and payments18 |
| Offline baseline | Design, retired surface10, origin8, key masking14, owned API34 and client32 pass |
| Additional safeguards | Table classification11 including all eight original mutations, migration byte compatibility5, workflow shape12 |
| Staged source guard | 590 tracked files / 503 text blobs including this evidence record |

The table-classification check initially ran without its PostgreSQL environment and refused connection to the unused default port. It passed after explicit disposable port62563 was supplied; this was a harness invocation error, not a product repair.

Browser evidence is retained in the author's ignored `.qa/exam-s6-20261003/browser-accepted/` directory at browser HEAD `9c7b7c8a67df4a46b02e429182419e204711f34d`. It covers public/internal refusal, simulated exact-version approval and ordinary reference-only publication, a45-item DTZ start, saved listening response, authenticated native audio loading, closure of new admission after an incomplete head, fresh-document pinned continuation, and explicit media-rights refusal with preserved answers/history. Screenshots cover1440/390/320 pixels in light and dark themes; root inspected the player, saved answers and blocked-content message. Documentation-only dependency conflicts were resolved from the exact integration commit; runtime and browser sources and the migration registry match the tested candidate. Three unrelated PostgreSQL test files retain earlier historical-fixture setup in that browser checkout; their corrected versions were tested separately on the integration candidate.

The uniquely named browser project `hatoove-s6-browser-1791043828687-53320` was removed with its own volumes; independent label queries found none remaining. PostgreSQL tests used unique disposable schemas on the task fixture. Learner records, the learner runtime and existing data volumes were untouched.

## Remaining gates and follow-on work

No real educational content was approved. Synthetic approval is confined to guarded disposable fixtures. Headless screenshots do not establish iPhone/Android keyboard or audio behavior. Qualified educational/native-language/audio review, security/privacy/legal acceptance, useful live-feedback evaluation and live-operation authorization remain open.

Hosted CI must actually pass before integration, in order: S4 PR114, payments PR116, S5 PR118, then S6. No merge, production deployment, live payment, provider call or actual learner-data migration is claimed.

The broader pilot audit identified follow-on engineering for named exact-version content-review decisions and versioned saved-assessment explanations with language switching. Those need bounded contracts and independent review; this S6 delivery does not claim the full pilot goal complete.

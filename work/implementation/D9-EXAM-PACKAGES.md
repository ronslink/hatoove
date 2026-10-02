# D9 decision record — exam packages

Accepted product decision: Ron, 2 October 2026, recorded in [DECISIONS-ANSWERED-20261002](DECISIONS-ANSWERED-20261002.md). Implementation record: [completion issue #96](https://github.com/ronslink/hatoove/issues/96).

**Adoption update — EXAM-ADOPT-20261002-A:** Ron clarified that Hatoove delivers mock exams for preparation, not official examinations, and adopted [Claude's recommendations](CLAUDE-MULTI-EXAM-REVIEW-20261002.md). The [revised architecture](MULTI-EXAM-ARCHITECTURE-20261002.md) governs the next slices. No certification, proctoring or official pass claim is added.

The first package is **telc Deutsch B1**. Hatoove provides its own practice items; it does not import an examination board's item bank or imply official affiliation. Generated content remains unreviewed until the required qualified reviewer approves its exact version. A rights basis and an educational review are separate records.

**DTZ A2–B1 is the next package to implement**, after proving the telc preparation and saved-mock journey. Build reading, writing and listening internally in sequence, but **release DTZ fully for the supported written scope**, with all three sections and reviewed audio together. No partial reading/writing learner release. Adoption does not approve content or publish the package.

Ron also fixed **one play per DTZ recording in both practice and mock-exam mode**, preserved on resume, and **credit for one selected exam package only**. Credits cannot be pooled, transferred or refilled by creating/switching preparations. Keep an owner-and-exam entitlement ledger with idempotent usage and preserved legacy balances. The selected exam and its available credit must be clear to the learner.

**telc English B1 and other recognised English exams remain later candidates**, not committed launch packages. Each needs its own blueprint, versioned original content, rubric, qualified review and device evidence. The German grammar exercises and writing rubric must never silently become English content through a language selector. Defer third-package implementation while retaining a small language-independent contract check.

Four decisions stay independent:

| Dimension | First package / present state | Contract |
|---|---|---|
| Exam package | telc Deutsch B1 | Catalogue, task versions, rubric versions and evidence retain the package identity. |
| Exam language | German | Task material and learner responses follow the exam, not a translation preference. |
| Instruction and explanation language | German interface; de/en/uk/ar/tr explanation preference | Store the preference separately and snapshot it on a submitted text. Missing translations are labelled; Arabic direction applies only to Arabic explanation blocks. |
| Purchasing market | No paid offer in this pilot | A future market, currency, tax and payment decision cannot be inferred from exam or explanation language. |

Preparations bind the stable exam identity. Each new attempt or mock run resolves an eligible release and keeps the exact blueprint, form/task, rubric and media versions. A revision retains its original binding and text. Ordinary withdrawal prevents new starts but preserves existing resume/history; exceptional rights restrictions explain affected use without erasing responses. Public releases require approved content; internal preview remains explicitly labelled and server-restricted.

The grammar bank recovered in COMPLETE-SENTENCE is supporting practice. Its twelve published word-order items are labelled as a grammar drill, not a complete telc test part. The other recovered items remain unserved source pending curation. The second-package plan is adopted, with bounded implementation leases still required. Content approval, live AI, payments and deployment remain separately gated.

# EXAM-S4 internal DTZ writing evidence

Execution **EXAM-S4-20261003-A**, [issue 113](https://github.com/ronslink/hatoove/issues/113), base `40702692f9475fd850367530c940c03a8b954c5f`. [Implemented contract](../../docs/contracts/EXAM-S4.md); [official-source verification](../../docs/exam/DTZ-WRITING-SOURCES.md).

## Delivered scope

Two original generated writing prompts offer an immutable A/B choice before drafting. A separate internal v3 manifest provides writing-only SA practice and combined LV+SA practice, reusing the five exact S3 reading sets. Both forms explicitly identify partial internal practice. No complete DTZ release, human approval, official result or pass prediction is claimed.

The DTZ rubric has four distinct criteria, each with six labelled positions and its own provisional descriptors. Its worker policy receives the exact selected prompt/rubric and refuses unknown or malformed assessments. Feedback is an explicitly labelled technical simulation with no aggregate score. Source scale mapping was checked against rendered official practice-set pages 42, 43 and 47; no official tasks or complete descriptors were copied.

Forward migration 0027 adds one owned attachment to existing writing storage, preserves existing records and historical import hashes, and permits a rubric without an aggregate total. Run selection, finalisation and credit reservation share ownership and locking boundaries. Empty or exhausted writing remains submitted and unassessed, retaining completed objective results without spending another exam's allowance. Failed grading preserves original text and refunds its reservation; a successful assessment debits once. Revisions retain the selected task/rubric and original submission, while the run keeps its initial immutable attachment.

Catalogue, internal/public policy, withdrawal and explicit rights blocks cover direct IDs, worker calls/results, history and export. Rights restrictions persist through revision ancestry even when later releases reuse exact content. Account deletion removes attachment and writing data, rolls back atomically on failure, and prevents late worker resurrection.

The client reuses the writing lifecycle inside saved runs. Both prompts are readable before selection; draft saves, refresh, separate documents, exam switching, offline failures, conflicts, pending feedback, retries and independent revisions preserve work. Writing-only results avoid a fabricated 0/0 objective score. Default startup import/catalogue remains telc-only; internal DTZ is enabled only inside synthetic fixtures.

## Verification and independent review

Ignored evidence is under `D:/Hatoove/.qa/exam-s4-20261003/`; task/lease/worker records are under `D:/Hatoove/handoff/ron-agent/`. These directories, design originals and raw worker output are excluded from commits.

| Check | Result and scope |
| --- | --- |
| S4 offline contracts | 6/6, including strict package/transport contracts, distinct policy and unequal criterion scale discrimination |
| S4 client contracts | 16/16; retained S3 12/12, S2 20/20, S1 10/10 and owned client 32/32 |
| S4 PostgreSQL | 17/17 on combined source: forward upgrade, exact import, original manifests, owner/idempotence/race controls, selected-exam allowance, failures, rights ancestry and deletion |
| Retained PostgreSQL | S3 10/10; S2 package 15/15 and saved runs 14/14 |
| Account deletion | 20/20 independently repeated, including real attachment/draft rollback and subsequent removal |
| Submission preservation | 9/9, including two controlled PostgreSQL races with the actual owner gate and verified winner/loser backend PIDs |
| Required offline baseline | All seven scripts pass; design check retains the two existing warnings |
| Table classification | 41 tables, zero failures/findings |
| Compose and API surface | 37/37, including OpenAPI 43/43; exact disposable project removed |
| YAML parsing | Workflow and OpenAPI parsed successfully with the existing isolated yq container |
| Internal browser | 14/14; final evidence `browser-reviewed`, desktop 1440 and mobile 390/320, light/dark, keyboard focus, narrow labels, pending/failure/retry/revision/exhaustion |
| Default browser | 199/199 after the retained telc-label correction and explicit design reference root; `browser-default-final`. Subsequent prompt-chip CSS polish is covered by the final S4 browser run |
| Independent backend review | Approved original 212f044 and deletion-test cb80cca; integrated 448d968 and a3cc64a. Reviewer was not the author. Author evidence and independent offline checks were inspected; integrated PG was repeated by the coordinator |
| Independent race-test review | Approved exact blob `0a33ed8806d74f5e551627ac7bfac791ab14d80b` and inspected the integrated 9/9 result |
| Independent client/content/root review | Pending final frozen source and corrected rendered evidence |
| PR/CI/integration | Pending; delivery, review, green CI, merge and product acceptance remain distinct |

Backend and client authors used separate worktrees. The installed Docker Hermes agent authored the original two-file content delivery `bae3d40`, integrated as `4f8ec78`. Coordinator corrections preserve actual provenance and positive A1 descriptors. Claude's installed session was rate limited during its availability probe; no provider configuration was changed.

The retained deletion test initially asserted the old fixed step order. Its correction injects failure at the named draft-removal step, verifies the full new sequence including the attachment, and proves exact attachment/text restoration after rollback. No rollback assertion was removed.

Initial mobile screenshots revealed cramped long DTZ bands under the inherited one-letter layout. A focused wrapping correction and a rendered band-line/heading collision check address this. The new band-line check fails the old layout at 390 px; earlier screenshots remain diagnostic evidence. The default telc browser also detected removed telc-specific wording; that wording is restored conditionally without labelling DTZ as telc. The design-reference preflight requires `HATOOVE_DESIGN_ROOT=D:/Hatoove/design` in an isolated worktree; curated served assets are checked separately.

The existing submission/discard race observer expected the loser at an entitlement row lock. S4 adds an earlier shared owner gate, so the real loser correctly waited there instead. The repaired observer requires the exact advisory gate, restricted learner role and the deliberately paused winner PID in `pg_blocking_pids`; it retains the attempt-lock pause and all result/preservation/balance assertions. Both races pass without changing production locking.

## Remaining boundaries

Qualified educational, translation and rights review remains pending. Headless Chromium does not establish physical iPhone/Android keyboard/audio acceptance. S5 listening/full written forms and S6 complete DTZ release acceptance remain separate. Security/privacy/provider/legal/product approvals and production deployment are not granted by this slice.

Learner ports 4300/55440, existing data/volumes, paused work and recovery material remain preserved. Canonical main acquired unrelated uncommitted payment/client work during this execution; it must not be overwritten by a fast-forward. Integration continues in the isolated worktree. Task fixture cleanup and final handoff remain pending integration.

# PILOT-STABILIZE-01 — restore CI and complete pilot feedback

Execution `PILOT-STABILIZE-20261008-A`; issue [#155](https://github.com/ronslink/hatoove/issues/155).
Coordinator owns `codex/pilot-stabilize-20261008`, base `3dee6f4`, in a separate worktree.

## Reconciled state

Canonical main was behind 37 commits. It is now clean at `3dee6f4`, PR #154 merged.
The earlier untracked contract was preserved byte-for-byte locally; no recovery or handoff file is committed.
Feedback Stage 1 was deployed on 6 October at that commit. Public read-only probes on 8 October returned
200 for the front door, health and readiness, and 401 for unauthenticated feedback.
Those probes do not establish a signed-in product journey. Earlier central-record snapshots are historical.

## Candidate behavior

- The vendored library receives a sanitized, inert snapshot. Hidden views are removed; private inputs, account
  identity, submitted writing and quoted evidence are masked before mounting. Source values/styles and audio
  elements are untouched. Capture failure/timeout still permits a report without an image.
- The report has a preview, attachment opt-out and removal. Saving the report precedes image upload; upload
  retry never creates a second report. Closing/reopening fences late responses. Visible part ids are captured
  without asking the view to render, and removing context removes the payload as well.
- A voluntary five-language dashboard survey supports answers, a session-only “Later” and a persisted skip.
  It uses the frozen v1 question schema, escapes copy, refuses unknown question sets and fences owner/locale
  changes. A locale change refreshes only its own dashboard card.
- Operator credentials are mounted only into migration and a one-off operator profile, never app/worker.
  Operator has function execution, no direct table privileges. Retention policies independently restrict
  deletion to reports at least 30 days old; the function enforces the same minimum. No production purge ran.
- Images retain owner RLS, immutable attachment, 1.5 MiB/1600 px limits and the ordinary JSON body ceiling.
  PNG CRCs and decompressed scanlines are checked within a 64 MiB bound. WebP framing/container lengths are
  checked; compressed WebP entropy is not decoded server-side. Owner export includes image files as base64;
  operator notes stay private. Account deletion removes attachments.
- Playback calls keep client preparation-generation fencing while respecting the attempt-bound API's closed
  query/event protocol. The original v1 package has no playback allowance; rendered listening evidence explicitly
  imports the already tracked v2 listening package through the supported Compose migration-service CLI.

## CI corrections and verification

The PostgreSQL rubric assertion now observes the explicit 0049 owner approval and its named-decision basis.
Docker inventory includes the media preflight; package CLI parsing handles omitted `--media-root`.
Docker assertions retain key privacy and strict-policy negatives while using the current POOL-01, library and
corrected speaking-reference contracts. No existing migration checksum or approved content was rewritten.

Measured: offline baseline 14/14 groups; mirror offline 14/14; mirror database 11/11;
PostgreSQL owned API 35/35; feedback API 22/22; operator 14/14; upload/export/deletion 6/6;
image 12/12; config 20/20; workflow mutation tests 12/12. Production Compose source/rendered-model
checks and full Docker acceptance 40/40 pass. The focused rendered fixture proves desktop and Arabic phone
audio advances through capture/save/upload, unchanged live private values/audio element, returned focus,
attachment export, Later/skip/all five survey answers, upload retry without a duplicate report and timeout cleanup.
Evidence is local-only under `.qa/pilot-stabilize-20261008/`; it contains synthetic accounts, not learner records.
Real-HTTP binary/ordinary-method boundary and visible-Konto masking checks also pass. The older full
`app-browser-check.mjs` remains red: its baseline assumes retired navigation ids, German-only interface,
the former Üben catalogue and hidden legacy library hosts. The initial run fails before these changes;
the exploratory update reached additional stale S0/S1/RUX helper assertions. That broad rewrite is outside
this bounded feedback candidate, so the old harness files are preserved unchanged and no green result is claimed.
AGENTS explicitly treats this harness as a separate Docker/browser acceptance check, not a PR CI gate.
The focused new browser check covers the changed Stage 2 journeys and real HTTP runtime boundaries.
The original RC was independently rejected under R1; a final frozen review is still required.

R2 on frozen `27d1369` found optional survey text incorrectly required. The correction omits blank `next`;
an actual browser ratings-only round now persists successfully. R2 also requested contract alignment for
the conservative draft-masking decision; the contract now explicitly excludes drafts/quoted writing.
Session lists and checkout identity/balance details are masked as well. The first hosted durable CI job
exposed an omitted synthetic operator password in the TLS fixture; its eight scoped-role identities now
pass all 19 actual TLS connection/refusal legs. Draft PR [#156](https://github.com/ronslink/hatoove/pull/156)
is open; hosted offline/server/fixture and separate PostgreSQL checks passed on the initial candidate.
R2 also found capture could finish after a language/navigation change. The opening now cancels if locale,
route or visible immutable context changes during capture; delayed-capture browser legs verify the fence.
R2 independently marked frozen `1940098` READY for integration with no remaining actionable feature findings.
The next hosted failure was EXAM-S0's assumption that all shipped seeds remain unreviewed after 0049.
Its exact-version test now primes other eligible sections through a synthetic learner's real answers;
public-policy negatives use appended unreviewed set/task fixtures with approved positive controls. No
approved source rows or review records are rewritten. All six EXAM-S0 PostgreSQL groups pass locally.
The dependent production-runtime fixture now allocates13 and includes its distinct operator secret/receipt;
its offline cleanup/refusal/probe self-check passes, without claiming a fresh complete production runtime run.

The downstream durable sweep found eight more assumptions invalidated by the current approval/content
state. All eight corrected gates pass on the isolated local fixture. Historical rights, review-consumer
and explanation-ledger upgrades now observe their exact migration boundaries before later approvals;
the occupied-pool rollback compares full existing ledger bytes. Sentence grammar content requires its
recorded named approval while answer-key denial remains tested. Table classification includes the new
operator in actual protected-table grant mutations (175 explanation mutations detected).
S6 core explicitly covers the historical0034–0048 upgrade (16 groups); fresh fully migrated S6 parity,
admission and payments gates passed separately. Applying0049 to a pre-populated second exam uncovered
its authority DISTINCT missing exam identity, tracked in [issue158](https://github.com/ronslink/hatoove/issues/158).
No historical migration or approved content was changed. This follow-up is unassigned and must be resolved
before offering that multi-exam upgrade path.

## Final integration receipt — 8 October 2026,10:03UTC

R3 independently approved3b6d5ec; R4 approved the final one-line grammar receipt getter correction at
61e8eaa5d47f0ca7dba1e61e969156096b060e88. The explicit grammar PostgreSQL rerun passes14/14 and supersedes
an earlier accidentally memory-only local rerun. The safe effective_content_review function exposes
decision_ids; its consumer view does not. No product or migration change was needed for that assertion.
Editorial mutation suite passes23/23 tests with113/113 actual mutations, including the operator.

All five required hosted checks passed on final61e8eaa: baseline, server/API, exam/feedback fixtures,
durable PostgreSQL/runtime contracts ([run37760079285](https://github.com/ronslink/hatoove/actions/runs/37760079285)),
and the separate postgres workflow ([run37760079172](https://github.com/ronslink/hatoove/actions/runs/37760079172)).
The rendered scheduled job is normally skipped on PRs; the focused local rendered evidence passes.
Staged repository guard and exact file-list inspection passed before each publication.
[PR156](https://github.com/ronslink/hatoove/pull/156) merged at40779cef9f920531ea1c7b160358c4e7b926cc72;
canonical local main was fast-forwarded cleanly. All labelled local synthetic databases were removed;
learner data and previous branches/worktrees were preserved.

The source40779ce local linux/amd64 release image was built successfully and remains unpublished;
its image ID is5b3e06afe6b4e902bfe08f868782ff81ff431c698f5014702d27347bb17e2fdd.
Image media3/3 and packaged Stage2 artifacts/migration hash checks pass. This is a local image ID,
not a published registry digest or production rollout receipt. R3 confirms issue158 blocks older
pre0049 populated-multi-exam upgrade/restore paths; the already0050 pilot Stage2 upgrade is unaffected.

## Remaining acceptance

Delivery, independent review, green requiredCI and source integration are complete. Production release
and product acceptance remain separate; no Stage2 production deployment is claimed.
Emulated desktop/phone evidence cannot close physical iPhone/Android keyboard/audio checks.
Production needs a separately supplied operator secret, a measured connection allocation of at least 13,
and confirmation of the v2 listening release head. Human content review is not manufactured by these tests.

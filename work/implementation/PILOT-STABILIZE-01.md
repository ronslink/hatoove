# PILOT-STABILIZE-01 — restore CI and complete pilot feedback

Execution `PILOT-STABILIZE-20261008-A`; issue [#155](https://github.com/ronslink/hatoove/issues/155).
Coordinator owns `codex/pilot-stabilize-20261008`, base `3dee6f4`, in a separate worktree.

## Reconciled state

At the initial reconciliation, canonical main was behind 37 commits and was synchronized cleanly to
`3dee6f4`, after PR #154. The final integration receipt below records its subsequent update to `40779ce`.
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
The original RC was independently rejected under R1. R2–R4 subsequently approved the repaired frozen
candidate, as recorded in the final integration receipt below.

R2 on frozen `27d1369` found optional survey text incorrectly required. The correction omits blank `next`;
an actual browser ratings-only round now persists successfully. R2 also requested contract alignment for
the conservative draft-masking decision; the contract now explicitly excludes drafts/quoted writing.
Session lists and checkout identity/balance details are masked as well. The first hosted durable CI job
exposed an omitted synthetic operator password in the TLS fixture; its eight scoped-role identities now
pass all 19 actual TLS connection/refusal legs. Draft PR [#156](https://github.com/ronslink/hatoove/pull/156)
was opened at that checkpoint; hosted offline/server/fixture and separate PostgreSQL checks passed on
the initial candidate. Its final green CI and merge are recorded below.
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

## Final integration receipt — 8 October 2026, 10:03 UTC

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

Delivery, independent source review, green required CI, source integration and the separately authorized
Stage 2 production rollout below are complete. Product acceptance remains separate.
Emulated desktop/phone evidence cannot close physical iPhone/Android keyboard/audio checks.
Native review of new uk/ar/tr survey copy remains open. Human content review is not manufactured by these tests.

## Authorized production rollout — 8 October 2026, verified 17:26 UTC

Ron explicitly approved deployment of source 40779ce and new restricted operator access, then requested
“lets deploy.” Coordinator execution `PILOT-STAGE2-DEPLOY-20261008-P1` used independently reviewed
preflight, staging, backup/restore, serial migration and bounded smoke procedures (P1-R1–R4).
No older worker lease resumed. Runtime source is `40779cef9f920531ea1c7b160358c4e7b926cc72`;
the host-built immutable image is `sha256:a2626f839cf330f0896d99a4195e8a0239e3d84de376bc141bc2c6b6472a2f10`.
It is a retained host image identity, not a published registry artifact; the earlier local image 5b3e06a
remains a separate preparation artifact. All 12 recordings match the prior live image by name and SHA256,
and the built image passes shipped media resolution/framing/missing-media checks.

Live preflight measured a 16,037,555-byte database (about 15.3 MiB), 3134 MiB available memory and
67129 MiB free disk. PostgreSQL max_connections 30 minus 3 reserved covers the allocated 13 connections. The reviewed v2
listening head already contained practice playback rules and needed no import. Existing password files
remain unchanged. The new operator password is outside source, mode 0400 with the measured node UID/GID 1000;
it is mounted only for migration and the one-off operator profile, never app/worker. Nonsecret configuration
remains root mode 0600 with its original inode; its prior copy and the old host image are retained.
Source 3dee6f4 remains recoverable from Git; staging overlays the live source directory.

The app/worker stopped before backup; no other client backend, migrator or claimed grading job remained.
The protected pre-migration custom dump and role globals are retained, with SHA256 respectively
`0d1f3eafab9090c33c3947bbbe311fe297f444f3f192ad79f881dca2568a0624` and
`57ddf24323037003fdcdd2c2ca1098520fbea8c180f27d7f3d3b9a94ebbcfc0d`.
Restore ran in a labelled, network-disabled 768 MiB container with 512 MiB tmpfs, never the production volume.
All 622 normalized metadata lines matched: migration ledger/checksums, schema/table owners, roles and
membership options, table/column/function/default privileges, policies/FORCE RLS and every owned-schema
table count. The temporary container was removed using its exact label; backup and private logs remain
root-controlled. No backup contents, password hashes or learner rows are committed.

Two refusals are retained honestly. The initial backup parent did not exist and was created root mode 0700.
The first actual restore succeeded but raw ACL comparison failed because PostgreSQL restored explicit
owner-default full grants as equivalent null/default ACLs on seven tables. Independent P1-R3 approved
object-type `acldefault` normalization, preserving all explicit grants/revocations and other metadata.
A fresh synthetic restore with 21 matching metadata lines and a second actual restore of the same retained dump then passed;
fresh unchanged source metadata and exact dump/globals hashes were required before migration resumed.
This is a demonstrated protected local logical restore, not an encrypted off-host backup or an RPO/RTO claim.
No automatic database downgrade or restoration over the retained live volume was performed.

Fresh migration 0051 applied only after verified restore. Ledger head is `0051-pilot-feedback-operator`,
with 49 entries and checksum `1c92023e131f57deb85ad0a98ee572e0f4f14f79f35f44b5005b58e48b398316`.
App and worker restarted only after that exact ledger gate; failures during maintenance/startup would
request both stopped. Both run image a2626f83 with 0 restarts, app health passes, worker has its restricted
database connection and public HTTPS `/api/ready` returns 200. Database and both certificate/configuration
volumes retain their prior identities; ingress and unrelated services were not changed.

Restricted operator authentication/function listing succeeds, while direct feedback/account SELECT is
denied. The operator has no feedback table privileges, SUPERUSER, CREATEROLE, INHERIT or BYPASSRLS.
The real CLI list output stays private outside source. Five bounded synthetic HTTPS smoke groups pass:
secure signup/session; feedback and genuine opaque PNG upload with anonymous denial, immutable retry
and exact owner export; attempt-bound listening begin/private 206 audio with anonymous denial; survey
eligibility read; and verified hard account deletion/session revocation. The deletion receipt confirms
one feedback and screenshot removed and verifies all account-table absence; direct DB metadata confirms
both synthetic report/image rows 0. The synthetic PNG proves transport/export, not production DOM capture
or physical-device audio. Existing desktop/Arabic-phone rendered evidence remains the UI evidence.

No production survey round was seeded, no answers/skip were written, no operator purge ran and no live
payment/model call was enabled. Answers/skip remain proven on isolated fixtures; a live survey round
needs its separately selected window/minimum age. Physical iPhone/Android, new uk/ar/tr copy review,
off-host backup operations and issues 157/158 remain separate follow-ups. This receipt does not mark
content approved, predict exam readiness or close product acceptance.

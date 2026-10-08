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

## Remaining acceptance

Final candidate review, staged repository guard/file-list inspection, PR and hosted CI, merge and production
release are separate transitions. No Stage 2 production deployment is claimed.
Emulated desktop/phone evidence cannot close physical iPhone/Android keyboard/audio checks.
Production needs a separately supplied operator secret, a measured connection allocation of at least 13,
and confirmation of the v2 listening release head. Human content review is not manufactured by these tests.

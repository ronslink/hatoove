# EXAM-S2: package imports and saved section practice

Execution **EXAM-S2-20261003-A**, issue [107](https://github.com/ronslink/hatoove/issues/107), base `3a010e64183b470848631e35c1956ee603c4c2ff`. Implementation delivered; final independent review, current-head CI and PR integration are recorded separately. No product acceptance or production deployment is claimed.

## Delivered behavior

The first form is `telc-deutsch-b1.reading.01@v1`, release `v1`: 20 reading items across the exact LV1/LV2/LV3 versions, explicitly labelled an untimed section exercise. Starting pins preparation, exam, release, blueprint and form. Answers and position are saved on the server. A fresh document resumes the acknowledged snapshot. Finalisation freezes it, marks objective items once, records unanswered items explicitly and reveals per-item answers/explanations. Retakes receive a new identity. No writing job, credit debit, complete-written claim or overall pass prediction is introduced.

Migration 0024 adds immutable blueprint, release, form and membership records plus a privileged publication pointer. Migration 0025 adds owned runs/receipts with forced RLS, exact composite foreign keys, protected identity/result fields and a privileged finaliser. Account deletion serialises with run writes; preparation archive serialises with start/save/finalise. Export retains owned snapshots. Existing content, schema history and learner rows are preserved.

The minimal JSON importer validates supported renderer shapes, exact references, answer vocabularies, item identities, coverage, counts, review/rights and both save-transport limits. It stores keys separately from public metadata. Dry-run checks the actual database without mutations; a changed immutable version fails atomically. An identical old import cannot reactivate an older publication. Ordinary withdrawal preserves pinned history; an explicit rights block withholds protected content/result while retaining saved responses. Imported objective sets also obey publication gates through standalone direct-ID routes.

The telc-only runtime allowlist remains. DTZ and English files are synthetic internal contract fixtures, excluded from the runtime image. The English fixture demonstrates a separate language, band model and fractional assessment scale as source data; it is not a released examination. New imports are generated/unreviewed and cannot grant themselves qualified approval. Complete written forms are rejected until the later reviewed listening/writing contract.

The client uses the existing German orange design. It handles loading, empty/unavailable content, save acknowledgement loss, stale-tab conflicts, explicit reload with a retained local copy, session change, archive, rights block and deadline expiry. It saves before navigation and resolves deep links to the original preparation. Visible keyboard focus, shared readable task labels and finalised deadline labels were verified during review. The initial real form has no reading-only countdown; timed behavior uses synthetic fixtures.

## Evidence

All runtime checks use disposable source-only Docker projects or PostgreSQL schemas with synthetic accounts. The existing learner preview on 4300 and database on 55440 were never test targets or refreshed for this slice.

| Check | Result |
|---|---|
| New package contract fixtures | 14/14 |
| Package importer, immutable versions, policy and transport limits on PostgreSQL | 14/14 |
| Saved-run transport/port contract | 8/8 |
| Saved-run ownership, finalise/archive/delete/publication races on PostgreSQL | 14/14 |
| Client state, retry, context and deadline contract | 20/20 |
| Complete rendered journey, including final deadline/focus/title repairs | 199/199 |
| Disposable Compose, importer CLI and lifecycle | 37/37, including OpenAPI 42/42 |
| Retained S1 preparation PostgreSQL contract | 11/11 |
| Provisioning / deletion / protected-key checks | 6/6, 19/19, 5/5 |
| Table classification | 40 rows, zero failures/findings |
| Table-class mutation proof | 10/10 tests; all eight mutations detected |
| Required offline baseline | All seven commands pass; design has two existing warnings |

The workflow now runs package, saved-run and client checks in the existing offline/PostgreSQL jobs. The rendered journey remains a local/on-demand gate. Passing tests demonstrate runtime contracts, not exam validity.

Local screenshots and logs are deliberately untracked under `D:\Hatoove\.qa\exam-s2-20261003\`. The reviewed `browser-final` set includes saved desktop state, finalised result, keyboard focus, all three parts at 390/320px in light/dark, lost acknowledgement, conflict copy, archive, rights block, deadline and session expiry. `browser-candidate` covers the final readable-title delta. These Chromium emulations do not replace physical iPhone/Android keyboard/audio or Safari checks.

Regression discrimination: the prior package validator accepted conflicting IDs, a missing form ID, a missing question and a whitespace item token; the repaired validator rejects them. The prior client changed a timely finalised run to expired after its deadline; the repaired client preserves the server's frozen verdict. Source review also found response count/UTF-8 size and invisible focus-outline gaps; explicit negative and rendered checks now cover them.

## Authorship and independent review

The coordinator owns the package/importer, integration, harness wiring and review repairs. Separate bounded local workers supplied the run API/migration and client. Actual Docker Hermes supplied manifests/fixtures and corrected their first delivery in a separate bounded worktree. Its reports and both deliveries remain preserved in the ignored coordinator handoff.

Actual Claude remained unavailable until 12:00 UTC; no premature retry was made. The recorded OpenClaw provider conflicts with this chat's no-new-DeepSeek boundary, so no remote/provider change was made. A separate local reviewer inspected coordinator packages and backend code; the backend author independently inspected the client. The coordinator inspected fixture delivery and visual evidence. Final reviewed commit IDs and CI/merge receipts are added at integration closeout. No author approves their own slice.

## Remaining gates and next slice

Qualified content/rubric/media review, physical devices, provider evaluation, security/privacy/legal and product acceptance remain open. No learner records, existing volumes, paused Hetzner work or incomplete archive were removed. No live model, payment, email, DNS or production operation ran. Next in the adopted delivery order is S3 internal DTZ reading; its roadmap entry does not grant an execution lease or permit a partial DTZ release.

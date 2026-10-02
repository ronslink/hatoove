# Learner journey completion — 2 October 2026

Execution **COMPLETE-20261002-A**, [issue #96](https://github.com/ronslink/hatoove/issues/96), [PR #97](https://github.com/ronslink/hatoove/pull/97). Base `2711900` on `codex/local-origin-01`; integration branch `codex/pilot-completion-20261002`. This is a local pilot candidate stacked on PR #95. Delivered, independently reviewed, CI green, merged and product accepted are distinct states.

## Delivered behavior

- German landing with working registration/sign-in/app entry, password recovery and verification pages. Recovery delivery is described as operator-assisted. Token URLs are scrubbed and recovery failures remain actionable.
- Session-owned writing history, exact saved task/rubric/text/feedback, revisions and learner export. Withdrawing content prevents new practice but does not hide already-saved work.
- Draft saves flush before navigation; two-writer conflicts require an explicit resolution. Failed comparison requests can be retried. Offline edits stay visible. An uncertain submission reuses its event identity and cannot be discarded as a draft.
- Five mobile tabs and an extras view; structured guide content retains all303 examples, with15 incorrect examples explicitly labelled. The saved feedback's language controls its direction rather than the current preference.
- Authenticated bounded sentence-structure hints without persistence, model calls or scores;240 original grammar items recovered as source,12 published as generated/unreviewed word-order practice. The other228 remain unserved pending curation.
- New task use checks both rights and review policy. The five supported explanation languages are validated. [D9](D9-EXAM-PACKAGES.md) records the independent package/language/market decisions.
- Claude's two bounded assignments repaired persistent-test signup isolation and exact-version discrimination, then fixed account deletion after objective practice and revoked the writing worker's unnecessary answer-key access. Migration0021 changes no existing learner row;0022 adds versioned grammar content.

## Review and evidence

The coordinator reviewed backend and entry contributions independently of their authors. The entry worker independently reviewed the coordinator's client, found five recovery/rendering defects, and verified their fixes at `2c7f714`; its final review at `52fbd1749749819c48d9fa84e92e056dde8fbc52` also verified guide order and a discriminating new-revision-close check. The backend worker independently identified an objective-label regression and verified its correction at the same final pin. It separately reviewed Claude's deletion migration and key-grant correction with no blockers. Neither worker reviewed its own implementation as independent acceptance.

Synthetic, isolated evidence at the completed learner-code head:

| Check | Result |
|---|---|
| Learner browser journey |124/124; fresh return, revision, conflicting saves, offline recovery, lost submission reply, accepted submission read failure, export, guides, sentence and grammar views |
| Account entry/recovery browser |36/36; desktop/mobile, light/dark, actual synthetic reset/verification and expired/reused-token paths |
| Docker composition |35/35; fresh migrations, idempotency, least privilege, auth, catalogue, server marking and restart |
| Owned API |33/33 memory and33/33 for each regular/persistent PostgreSQL mode |
| Saved-work API |8 memory /10 PostgreSQL |
| Rights policy |6 PostgreSQL, no pending assertion |
| Sentence and recovered content |12 offline /14 PostgreSQL |
| Account deletion |19/19; evidence included, forced rollback, cross-owner preservation, scoped read-back |
| Answer-key access |5/5; both runtime refusals and a reversed-grant positive control |
| Worker |14/14; simulated grading, leases, retry, concurrency and assessment contract |
| Retired config route |7/7; anonymous401, authenticated404, configuration unchanged |
| Table classification |28 rows, zero findings;7/7 privilege/policy mutations detected |
| Account HTTP and learner API journey |6/6 and11/11 with no pending legs, after persistent CI prerequisites |
| Hosted refusal and session lifecycle |6/6 each |
| Migration upgrades |7/7 LF/CRLF discrimination and actual upgrades; existing migration/runtime suite6/6 |
| Offline baseline |design14, retired10, origin8, keymask14, owned-api33, owned-client31; source guard passes |

Desktop/mobile screenshots were visually inspected, including landing, saved result, conflict/offline states, revisions, guides, sentence hints and grammar questions. Logs, screenshots, Claude transcripts and the local database backup remain ignored local evidence, not repository content. Viewport emulation is not physical-device acceptance.

The first remote CI run exposed obsolete empty-language assertions in the account HTTP check and stale journey-route expectations. The corrected accounts6/6 and journey11/11 suites now verify saved content and ownership, not mere successful status codes. The coordinator independently reviewed the worker's `e5af9f3` delta; this changed only tests.

A local update exposed an LF/CRLF checksum mismatch between the original checkout and a new Windows worktree. The checksum guard refused the update; the original preview was restored while the focused fix was prepared. Independent coordinator review of `87e92f4` confirmed that only complete LF/CRLF conversion is accepted for an already-applied migration; SQL, comments, other whitespace, BOM, final-newline, mixed-ending and bare-CR changes are rejected. Raw checksums stay distinct and recorded history is unchanged. Both upgrade directions preserve ledger timestamps and a saved row, apply only the pending head and refuse a substantive SQL mutation. Future SQL checkouts are pinned to LF. This check is now a durable CI gate.

The refreshed local Docker preview is healthy. Its migration step applied0021 and0022, skipped18 and backfilled0; the existing volume and count-only learner totals are unchanged. The user browser was reloaded and the German entry was verified visibly. Source is the attached completion worktree, which must remain available for the current Compose configuration. The canonical checkout's earlier branch and other unfinished work were preserved. Final GitHub CI and integration status are recorded on PR #97; no production deployment or product acceptance follows from the local refresh.

## Remaining acceptance

Writing feedback is still a labelled deterministic simulation, not useful live model feedback. D10 requires a cost cap, human comparison and privacy/DPA review before live calls; D12 refill depends on those gates. Listening awaits commissioned recordings. Qualified educational/content review, release security/privacy/legal review, and actual iPhone/Android keyboard/audio checks remain open. No overall exam prediction, second-exam implementation, production deployment, payment or external email is authorized or claimed by this batch.

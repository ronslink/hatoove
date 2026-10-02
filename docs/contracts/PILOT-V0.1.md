# Pilot contracts 0.1.0 — PRE-05 / F-03

Coordinator decision, 30 September 2026; issue [#7](https://github.com/ronslink/hatoove/issues/7).
Status: executable local spike plus integration specification. No external pilot or production approval.
Breaking changes require a version bump and coordinator-recorded consumer migration. Do not infer a fixed table count.

## Runtime and account boundary

Selected local path: Node ESM, Better Auth **1.7.6**, `pg` **8.23.1**, ordinary PostgreSQL and a background worker in the same codebase. No framework or hosting migration. The spike pins dependencies and lockfile separately under `spikes/auth-runtime`; the legacy root package remains runnable unchanged.

The library owns `user`, `session`, `account`, `verification`; application `owner_id` references its **text user ID**, not an assumed UUID. The exact generated SQL is `spikes/auth-runtime/auth-schema.sql`. Tests compare newly generated SQL with that snapshot and apply the migration twice. Library changes must regenerate/review this schema; production must use reviewed, ordered migrations with a separate migration role, never startup auto-migration.

Sources: [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql), [core schema and programmatic migrations](https://better-auth.com/docs/concepts/database), [security controls](https://better-auth.com/docs/reference/security). Package installation and local execution establish compatibility; documentation alone does not.

Sessions are server-backed; account identity comes only from the verified session. Cross-owner resources return the same 404 as absent resources. Browser caches must be keyed by account and contract version; sign-out/account change cancels in-flight saves, clears private caches and resets exam view state before the next account loads. A late response from a previous account cannot populate the new account. This browser boundary is specified, not implemented in the spike.

The spike has no executable production server. It binds an ephemeral loopback port, uses synthetic email/password accounts, no email delivery and no `.env` loader. Verification/recovery email, secure production cookies/TLS, distributed abuse controls, session expiry tests, limited SQL roles and forced RLS remain A-01/F-02 prerequisites. Human security review of these controls is required before external pilot admission.

## Route and error contract

All learner responses use `Cache-Control: no-store`. Mutations require exact trusted Origin and JSON, including auth POSTs. Bound bodies to 64 KiB and writing text to 12,000 UTF-16 code units. Unknown fields fail; the client cannot set ownership, prices, marks, models, prompts, provider URLs or job states. Error envelope: `{error: code}` with no text, SQL, credentials or provider response in logs/errors.

| Route | Control / result |
|---|---|
| GET `/api/health` | Public minimal status, contract version; no provider/config details |
| POST `/api/auth/sign-up/email`, `/sign-in/email`, `/sign-out`; GET `/api/auth/get-session` | Exact library route allowlist; same-origin mutations; sign-out invalidates stored session |
| GET `/api/v1/account` | Authenticated `{contractVersion,id,email}`; identity never accepted in learner input |
| POST `/api/v1/attempts` | Owned attempt; optional owned `parentSubmissionId`; synthetic fixed task in spike |
| GET/PUT/DELETE `/api/v1/attempts/:id` | Owned read, revision-checked draft save; DELETE tombstones an unsubmitted draft only, and a submitted attempt answers 409 `submitted_attempt` |
| POST `/api/v1/attempts/:id/submissions` | `{expectedRevision,eventId}`; 202 after submission, job and reservation commit |
| GET `/api/v1/submissions/:id` | Owned immutable snapshot, job status and saved assessment or null; never regrades |
| POST `/api/v1/submissions/:id/retry` | Owner-only retry of eligible failed job; same submission and job identity |

401 unauthenticated; 403 rejected Origin; 404 unavailable resource/route; 409 conflict (draft, idempotency, submitted revision, submitted attempt delete, allowance or retry); 413 body limit; 415 non-JSON; 422 invalid fields/content; 500 redacted unexpected failure. Invalid JSON/UTF-8 returns 400; startup may return 503. Origin validation precedes routing, so an untrusted mutation gets 403 even for an unknown route. Both byte and text limits apply; heavily escaped JSON can hit the byte cap first. Conflict never silently overwrites text: the consumer preserves local text and offers compare/reload/new revision.

Future legal/sign-in pages are explicitly public. OAuth callbacks, signed webhooks and designated anonymous tools are separate, currently disabled routes with their own state/signature/quota policies. Unknown legacy `/api/progress`, `/api/config`, `/api/ai`, `/api/ai/test` are not a pilot API. Authentication alone does not make arbitrary AI proxying acceptable.

## Records and state transitions

SQL in `spikes/auth-runtime/schema.sql` and executable fixtures in `test.mjs` define the implemented subset. UUIDs identify application records/events; auth user IDs remain opaque text. Field names in SQL/returned resource objects are stable for this spike; production DTO mapping must be versioned before browser integration.

| Record | Required invariants |
|---|---|
| Account/profile | Auth user plus future owned preferences: `examPackageVersion`, local-date `examDate`, IANA `timeZone`, `explanationLanguage`, independently selected `purchasingMarket`. No browser-selected grading model |
| Attempt | Owner, immutable task/rubric refs, optional same-owner parent submission, mode/assistance in future reviewed-content slice; tombstone wins over every write |
| Draft | One per attempt; revision starts at 1; save requires current revision and increments once. Wall clocks do not resolve conflicts. Submitted attempts require a new revision attempt |
| Submission | Immutable exact server-saved text, draft revision, task/rubric refs, owner and stable event ID. Unique owner/event and attempt/revision; SQL trigger rejects snapshot updates |
| Job | One per submission, queued → running → succeeded/failed; failed → queued only with allowance and remaining tries. Attempt deletion no longer cancels jobs; `cancelled` rows from the retired delete behaviour remain as history |
| Assessment | One authoritative saved feedback/evidence record per submission, model/prompt/rubric versions. The spike accepts synthetic feedback only, with no numeric score |
| Entitlement | Server-created allowance; `used + reserved <= allowance`; no negative counters. Spike entitlement is a fixture, not a purchase |
| Usage ledger | One successful unit per saved assessment, uniquely keyed by submission; failed/invalid/cancelled jobs do not debit |

Submission identity is `(owner,eventId)`; its immutable fingerprint is `(attemptId,draftRevision)` because submitted draft text and task/rubric refs cannot change. Same key/fingerprint returns the same submission; a different fingerprint conflicts. A new key cannot resubmit the same frozen attempt. On an uncertain response after commit, retry the **same** event ID. This is not a promise of exactly one provider call.

Enqueue is one checked-out PostgreSQL client/transaction: lock owner entitlement, lock owned non-deleted attempt, resolve idempotency, verify draft/allowance, insert submission and job, reserve one allowance, commit, then acknowledge. A failed enqueue leaves no partial submission, job or reservation.

Workers claim with `FOR UPDATE SKIP LOCKED`; lease token changes on every claim. Local fixture lease is 30 seconds, maximum three claims. Expired final claims are reaped to explicit `retry_exhausted` failure and release reservations. Provider work must occur outside SQL transactions. Completion checks live lease token using database time and the attempt tombstone, and commits assessment + successful usage + counter update + job success atomically. Late/duplicate workers have no effect. Permanent malformed output remains unassessed; retries are bounded and classified. A deployed worker needs polling, graceful shutdown and a reviewed lease renewal policy before long provider calls.

Lock order for operations touching multiple resources is entitlement → attempt → job. Claim only locks the job and commits immediately; never await provider work while holding a lock. Actual provider requests/spend need a separate append-only provider-run record, including ambiguous/repeated calls; no provider calls occur in this slice.

No background process is started by this spike. Reservations intentionally remain attached to accepted unfinished work while the worker is down; recovered polling reclaims expired attempts 1–2, and reaps attempt 3. Before deployment, implement and monitor continuous polling/reconciliation and define the recovery window; do not claim reservation recovery while every worker is stopped. `provider_unavailable` and `malformed_feedback` permit explicit bounded retry; `retry_exhausted` never does. A request rejected as malformed never produces an assessment or debit. The migration helper's 55436 base URL is a non-listening configuration placeholder; the only database port is 55435. A randomly generated default auth secret is test-only and does not provide restart continuity; the tests explicitly share one secret between their auth instances.

## Content, objective marking and audio boundary

The synthetic writing task is **not reviewed educational content**. E-01 supplies dated official blueprint and expert review before real task integration: task family, item count, timing, mode/assistance/playback policy, valid answer IDs/no-match constraints, weights and rubric. E-02 implements deterministic marking using private immutable keys. Public content DTOs contain prompts/options/audio references only; no key, future score or arbitrary client mark is authoritative.

Content versions record rights/source and human review events, with separate educational, native-language and audio approval. Assets record content version, checksum, duration, rights and reviewed playback policy. A fixed recording is served consistently across browsers; browser TTS is not assessed listening. Historical attempts retain exact versions. No content/audio is approved by this spike; speaking/STT stay excluded.

Writing feedback is provisional and formative. C-05 must version and validate the actual three-criterion rubric/evidence and calibrated numeric policy before replacing the synthetic adapter. Provider failure cannot yield a heuristic mark. Reopening or translating saved feedback does not enqueue a new grade; translations reference the original assessment and their own language/version/review metadata.

## Sync, deletion and privacy

Use stable event IDs, server revisions and explicit conflicts. Client timestamps and legacy progress merges cannot choose authoritative writing text or scores. Cross-device return means a second authenticated session retrieves the same draft/submission/assessment; browser recovery remains a separate consumer task.

Attempt delete discards an **unsubmitted draft only** (SUBMISSION-PRESERVE, 2 October 2026). In one transaction it locks the owner entitlement and then the owned attempt row — the same order as submit — and refuses with 409 `submitted_attempt` if any submission exists, whatever its job state (queued, running, succeeded, failed); otherwise it writes the tombstone and removes the draft. It never cancels a job, releases a reservation or debits. Because submit and delete serialise on the attempt row, a delete from a stale draft view either sees the committed submission (409) or commits first so the submit sees the tombstone (404). Ownership is checked before the submission test, so another owner's submitted attempt is the same 404 as an absent one. Stale saves, submissions, retries, revision-parent links and late completions cannot recreate a tombstone. The earlier behaviour (tombstone a submitted attempt, cancel queued/running work, release its reservation) is retired; tombstones it wrote stay in place with their immutable submissions/results. **This is logical deletion, not privacy erasure**; erasure is the account hard delete. A-05 must add account deletion, physical text/asset purge, export authorization and retention jobs. Backup expiry and restore/reapply-deletions require human-approved periods; none are invented here. Tombstones cannot expire while older client events or backups may replay.

Export v1 will contain owned profile, attempts/drafts, immutable submissions, saved assessments, version references and permitted usage history; exclude auth tokens, password hashes, private keys and other accounts. As implemented, `attempts` lists live attempts with their drafts, while `submissions` and `results` list **every retained submission of the owner**, including those under attempts tombstoned by the retired delete behaviour. Each of those rows carries `attempt_deleted_at` (null while live), so retained data never disappears from the export and tombstoned history is never presented as live. Legacy import is explicit, previewable and idempotent; preserve original scoring labels and never treat legacy client marks as newly reviewed evidence.

## Commercial, language and analytics extension points

Versioned server catalogue: product/exam/duration/allowance, market price/currency/amount. Order records snapshot the agreed values and verified payment event IDs; entitlements derive only from verified server state. Refund/dispute/revocation rules need P-01/P-02 decisions before implementation. Language or IP alone cannot determine market. Purchase, expiry, refund and provider-cost handling are unimplemented; successful-unit accounting above is an executable reservation/debit experiment only.

Supported explanation languages must be explicitly declared and natively reviewed before enablement; no launch-language list is assumed here. German exam text retains its direction within RTL UI. Event names may include `draft_saved`, `submission_accepted`, `assessment_completed`, `assessment_failed`, `attempt_deleted` with contract version, section and classified outcome; no learner text, email, session token or direct learner identifier. Analytics collection is not enabled in the spike.

## Next implementation slices

1. F-02/A-01: restricted runtime/migration roles and RLS, owned profile, session/recovery/abuse negatives; reviewed migrations and local operator workflow.
2. PILOT-02-DRAFT: coordinator-owned `public/js/exam.js` integration, task identity and owned draft autosave/recovery using this contract; account-scoped cache with sign-out/late-response isolation. Never put new drafts into the global legacy progress blob.
3. PILOT-01-CSS: reproduce source-reported phone/tablet issues, preserve desktop appearance; exact separate assignment and screenshots. Real keyboard/audio evidence stays open.
4. E-01/C-03/E-02/C-04/C-05 then A-02/A-03: reviewed real tasks, private marking, fixed audio and validated formative provider adapter. Passing fixtures cannot close these human gates.

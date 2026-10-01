# HARD-DELETE-02 — D3: implement the account deletion

Worker: **Claude**. Execution id: `hard-delete-02-claude-20261001-a`.
Coordinator: `COORD-TAKEOVER-20260930`. **Checkpoint 30 minutes · Expires 180 minutes.**

## Base

**`origin/codex/ownapi-03-persistent` @ `e621618`** — the candidate. Record the SHA.

## The authority — read it first

**`work/implementation/HARD-DELETE-01.md`** in that checkout. It is the complete specification: the deletion graph
read from the schema, the eleven-step order, the acceptance criteria, and what is deliberately **not** decided. This
brief does not repeat it; it tells you where the sharp edges are.

**Ron's decision, verbatim: *"delete is a hard delete."***

## Why a naive deletion cannot work — the two structural facts

1. **There is no `ON DELETE CASCADE` on any ownership key.** The only cascading key in the whole schema is
   `learner_settings.user_id`. So `DELETE FROM "user"` **fails today**.
2. **There is a foreign-key cycle.** `submissions` references `attempts(id, owner_id)`, and `schema.sql` then adds
   `attempts.parent_submission_id → submissions(id, owner_id)`. **The first step of any working deletion is
   `UPDATE attempts SET parent_submission_id = NULL`** — and it is the step an implementation is most likely to miss.

The eleven steps are in the spec, in order, with the cycle broken first.

## What to build

The route and the deletion. Choose the route shape deliberately (`DELETE /api/v1/account` is the natural one given
the existing `/api/v1/account` GET) and **say why you chose it**. It must be **session-derived** — no owner
parameter, no header, no body field naming an account. **The runtime refusals slice just removed exactly that
pattern from the legacy path; it must not reappear here.**

**The whole deletion runs in ONE transaction.** A partial deletion that leaves an account half-removed is worse than
a failure.

## Acceptance — report ACTUAL output

Written to be testable rather than aspirational. From the spec, plus what this session has learned:

1. **Read-back proves absence per table**, per the spec's list — not the delete's own row counts. A delete that
   reports success and leaves rows is the failure mode.
2. **Another account's rows are counted before and after** — counted, not asserted by inspection. This programme has
   found four checks that passed for the wrong reason; do not add a fifth.
3. **No live session survives**: the same cookie is refused immediately afterwards, and that check is part of the
   same transaction's consequences.
4. **Deleting an already-deleted or non-existent account is idempotent** and reports honestly.
5. **A forced failure part-way leaves the account INTACT, not half-deleted.** Inject the failure after step 5 and
   assert every table still has its rows. This is the check most likely to be skipped and the one that proves the
   transaction.
6. **DISCRIMINATION**: the new checker must **fail on `e621618`** (where no deletion route exists) and pass on your
   head. Paste both outputs.
7. **Baseline unchanged**: `check.js` 101 · writing 9 · feedback 14 · server-origin 16 · keymask 12 ·
   `reset-check.mjs` **8** · revision 8 · progress-equal 10 · owned-client 31 · owned-api 24 · draft-session 18 ·
   mock-outcome 19 · progress-scope 7 · design-check exit 0 · provider-config 11 · **saas-runtime 10** ·
   **session-boundary 13** · **session-boundary browser 52** · `accounts-http-check` 6 · repository-check passes.
8. LF not CRLF; `git diff --cached --check` clean; `.mjs` checkers run from a file.

## The honesty requirement — this is not optional

**A deletion cannot reach everything**, and SEC-02 already committed this programme to saying so: *"deletion is not
total, and saying so is part of the fix."* The route's response must **state what was not removed** — the operator's
backups are outside the application's reach, and the retention window for them is **a decision Ron has not given**.
**Do not invent a retention policy.** Do not claim total erasure. Say what happened and what did not.

## Deliverable

- Branch `codex/hard-delete-02` from `e621618`.
- Allowed: `server/owned-api.mjs`, `server/owned-postgres/adapter.mjs`, `spikes/auth-runtime/schema.sql`
  (**only** if the spec's explicit-order approach proves unworkable and you switch to cascades — if so, **say so
  loudly and explain the trade**, because a cascade weakens the guarantee that a mistaken `DELETE` is caught),
  `tools/deletion-check.mjs` (new), `work/implementation/HARD-DELETE-01.md` (append only — the spec is the record).
- **Do not touch** `public/**`, `server.js`, `server/accounts.mjs`, `server/owned-postgres/provision.mjs`,
  `.github/**`, `package.json`, or any other record.
- **Commit and push after each numbered step, separately.** This rule has saved two runs.
- **Open a draft PR** — a branch with no PR gets no CI, which already cost a check cycle here.
- **If the eleven-step order turns out to be wrong** (a dependency you discover the hard way), **stop and report the
  corrected order** rather than inventing a workaround. The spec being wrong is a finding, not a failure.

## Boundaries

- Synthetic accounts only. No real learner record. **`D:\B1_Prep` is Ron's live install — never touch it.**
- Use a **disposable** PostgreSQL; the deletion tests genuinely delete.
- No deployment, no production access. **This closes no gate**: `P-03`/`X-01` stay open and issue #63 is explicitly
  not a production-security approval.
- **State plainly what you could not verify** — including that the operator-backup question is unanswered by
  design.

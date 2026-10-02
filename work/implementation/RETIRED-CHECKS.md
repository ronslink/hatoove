# RETIRED CHECKS — the ledger

A check guards a **property**. When its implementation is removed, the property is either moved to a new vehicle or
it is void, and this file records which — so that a deleted check is never mistaken for a passing one.

**The rule** (an architect review of the functional-product direction, 2026-10-01). Write the property in one
sentence, in terms of what a learner, attacker or operator could observe, then ask one question:

> **Could a learner, attacker or operator of the *new* product observe a violation of this property?**

| Answer | Action | Conditions that must hold, or it is "deleting a failing check to declare victory" |
|---|---|---|
| **Yes, and only the vehicle changed** | **RETARGET** — keep the assertion, change what it drives | The retargeted check **fails on a tree where the property is broken** (discrimination leg recorded), and the retarget lands **in the same PR** as the vehicle change |
| **Yes, but the mechanism cannot exist in the new architecture** | **REPLACE** — new check, same property, new mechanism | The replacement is **green and discriminating on `origin` in or before the same PR** as the deletion; the ledger names the replacement file and leg |
| **No** — the property belongs only to the removed implementation | **DELETE WITH A RECORDED REASON** | Deletion happens **in the commit that deletes the implementation**, never earlier. Where the removal is itself a safety property, add a **negative check** proving the implementation is gone |
| **Unclear** | Treat it as **Yes**, then REPLACE | — |

**Three prohibitions.** No `skip`, `continue-on-error`, `|| true` or commented-out CI steps — a step is either
present and gating, or deleted with a row here. Never delete a check whose implementation is still reachable. And
**do not count retirements as progress**: this is a cost record, not a scoreboard.

**Columns:** `check | leg(s) | property | decision | reason | replacement file:leg, or "none — property void" |
commit that removed the implementation | slice`

---

## Retired

### 2 October 2026 — PILOT-06: an unfinished letter survives a reload (and three defects found getting there)

**The gap, and why the answer had to come from the server.** A learner who reloaded mid-letter got an empty
textarea attached to a **new** attempt while their writing sat in the database with nothing pointing at it.
The client cannot answer "which attempt is open" for itself — it keeps nothing in the browser (asserted by
`app-browser-check` L30) — so the answer is a route.

**`GET /api/v1/attempts?open=1`** returns the learner's unfinished attempts, newest first: **no text**, the
task binding, and the revision to save against. "Open" is exactly two things — no submission exists (a
submitted letter is a frozen snapshot, and resuming it as a draft would let a learner edit what was marked)
and not deleted (a tombstone is not a draft). `?open=1` is part of WHAT IS SERVED, not a parameter with a
validation error: any other query, or none, gets the same `404 not_found` the path already gives for an
unsupported method — the convention `owned-api-check` leg `error-404-unknown-routes-and-methods` already
asserts, so the new route obeys it rather than carving an exception into it.

`owned-api-check` leg **`an-unfinished-attempt-is-resumable-and-a-submitted-one-is-not`** was written first
and observed **red**, then green on **both backends** (30/30 memory, 30/30 postgres). It asserts the index
names the attempt, its binding and its revision; that **no field smuggles the text**; that a stranger sees
nothing; and that a submitted **or deleted** attempt is not resumable.

**DEFECT 1 — `attempts` had no timestamp, so "newest first" was meaningless.** The first adapter query threw
`column a.created_at does not exist` (SQLSTATE 42703) and the route answered **500**. The memory fixture had
been setting a `created_at` of its own, so the check passed on one backend and the route broke on the other —
which is the whole argument for running the same suite on both. Ordering by `id` was not an option (random
UUIDv4, so "newest" would have been an arbitrary order presented as a meaningful one). Migration
**`0016-attempt-created-at.sql`** adds the column (`NOT NULL DEFAULT now()`, so the INSERT needs no change)
and an `(owner_id, created_at DESC)` index that matches the query.

**DEFECT 2 — MY OWN "FIX" INTRODUCED A TDZ ERROR, AND THREE LEGS STILL PASSED.** Moving the autosave wiring
so it could not lose early keystrokes put `attemptId = attempt.data.id` **above** `let attemptId = null`: a
temporal-dead-zone `ReferenceError` that skipped the rest of the wiring — no listener, no enabled field, no
resume. The rendered legs went on passing because they were too weak: W3 asked whether a textarea *existed*
(a disabled one does), and **W4 asked only whether a HINT existed** — it passed while the autosave never
landed at all. What caught it was asking the **SERVER**: `W4` now reads the draft back through
`GET /api/v1/attempts/:id` and asserts the text and a revision of at least 2 (`server holds 77 char(s) at
revision 2`). *A save is only a save if the server agrees.* The lesson is the same one this ledger already
carries three times — "present" is not "working", and "a message is on screen" is not "the data is stored".

**DEFECT 3 — the text field was editable before the save path existed.** The textarea rendered while
`openAttempts`/`createAttempt` were still in flight and the listener was attached afterwards, so keystrokes
during that window were dropped; on resume, anything typed before the stored text arrived would have been
**overwritten** by it. The field and the submit button now start **disabled**, the listener is attached up
front, `saveNow` does nothing until there is an attempt, and they are enabled once the attempt is ready.
`app-browser-check`'s helper waits for a READY field, so no leg can type into one with no save path.

**Rendered proof, with the server in the loop.** Legs **W8/W8b**: type into a second task, wait past the
debounce, and the leg reports `before reload DOM=61 server=61 [{task, rev:2}]` — then a **real** `Page.reload`
(a `Page.navigate` to the same hash does not re-route; the diagnostic the helper prints showed the old view
still on screen) — and after it, `DOM=61`. W8b opens the **submitted** task again and asserts its snapshot is
**not** offered as editable text, so a naive "the text is there" check cannot pass on the wrong behaviour.
Screenshots `13g`/`13h`. **73/73 legs** (was 71).

### 2 October 2026 — PILOT-06/3b: a fabricated assessment can no longer be STORED, and a flaky check is fixed

**The rubric contract is OPEN (MASTER-PLAN D4, R11):** a separately versioned three-criterion contract, or
honestly labelled provisional four-criterion internal feedback — the notes say the two must never be
renormalised into each other, and PILOT-06's result schema is blocked on the decision. So this slice did
**not** decide it.

**What it did instead is close the hole the open decision leaves.** `completeSuccess` stored
`assessment.feedback` **verbatim** as JSONB. A grader — or a provider adapter, or a model whose response
shape drifts — returning `{total: 35}`, `{score: '35/45'}`, `{bestanden: true}` or
`criteria: [{score: 12}]` would have been written to `assessments`, served by `result()`, and rendered by
any present or future client as though the contract had been settled. That is a fabricated assessment, and
"no /45, no pass line" is a red-line product rule rather than a formatting preference. **No screen check
can see this**, which is why it is enforced at the point of storage.

`validateAssessment` (`server/owned-postgres/worker.mjs`) now runs between the grader and the transaction
and allows exactly what the product promises today: `feedback.kind`, an optional `feedback.comment`, and
the `modelVersion`/`promptVersion` the feedback was produced with. Anything else — a total, a score, a
band, a verdict, a criterion list, an unknown field — fails the job with the stable code
`invalid_assessment`, refunds the reservation, and stores **nothing**. When D4 is decided, that function is
the one place to widen, and widening it is a deliberate, reviewable edit instead of a silent consequence of
a provider changing its response.

**Check-first, with the red observed.** `worker-runner-check` leg **3b** was written before the validator
and failed with *"a total must FAIL the job, got succeeded"* — the fabrication, demonstrated. It asserts
six shapes are refused (a total, a `/45` fraction, per-criterion scores, a pass verdict, a bare number as
the whole feedback, and a top-level score beside the feedback), that each failure leaves **no assessment
row** and refunds the reservation, and — in the same leg — that the **shipped stub still succeeds**, so the
leg cannot be satisfied by a validator that refuses everything.

**That control case earned its place immediately.** The first validator reused the failure-code pattern
(underscores only) for `feedback.kind`, and the shipped stub reports `synthetic-formative` — with a dash.
It refused the one assessment the product actually ships, and the control case caught it on the next run.
A validator that rejects the real payload is not validating, it is breaking.

**Draft recovery on reload remains OPEN, and is not claimed.** A 409 is handled, but a learner who reloads
mid-letter gets an empty textarea and a NEW attempt: there is no route that says "which attempt is open",
and the client stores nothing in the browser by design (`app-browser-check` L30 asserts that). Resuming
therefore needs a server-side answer — a route listing the learner's resumable (unsubmitted) drafts, most
likely `GET /api/v1/attempts` — **or an explicit decision that a reload starts a new attempt**, which is
what happens today and is not recorded anywhere as a decision. It is recorded here as a gap, with the two
options named, rather than left to look like an oversight.

**Also fixed: `api-spec-check` was unreliable roughly one run in three, and it misled me.** It called
`process.exit()` while `fetch` keep-alive sockets were still closing, which trips a libuv assertion on
Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) and ABORTS the process. Measured: three consecutive
identical runs exited 0, then `0xC0000409`, then 0 — and my first reading of that was a suspicion about the
check's subject. It now sets `process.exitCode` and lets the runtime drain; four consecutive runs exit 0
with the same 25/25 verdict. The same class of crash was removed from `keymask-check`'s prefix mode in
SPA-RETIRE 5, where the assertion appeared *after* every check had passed.

### 2 October 2026 — PILOT-05: the writing journey gets a SCREEN, and its gap list shrinks

**The gap, stated plainly.** Four ledger rows recorded writing as UNPROVEN — `draft-session`,
`writing-surface`, the writing result screen and the mock-outcome view died with the SPA — and
`public/app/` never had a writing view at all: the Schreiben section listed the six seeded prompts and
**nothing could open one**. Draft → submission → result had no UI, and the API could not have supported
one: `POST /api/v1/attempts` took no binding, so every attempt was created against
`DEFAULT_TASK_BINDING` and a view could only have submitted against ONE task while showing another.

**Contract first, and red first.** `owned-api-check` leg `attempt-binds-the-servable-task-the-learner-opened`
was written before the route could satisfy it and observed **red**, then green on **both backends**
(29/29 memory and 29/29 postgres). It asserts, in one leg:

| Assertion | Why it is the property and not a detail |
|---|---|
| an explicit `{taskId, taskVersion, rubricId, rubricVersion}` binds the attempt to exactly that task **and version** | a learner who opens task B must not have task A marked |
| it is not silently the default task | the defect being closed |
| an unknown task id → **422 `task_not_servable`**, a foreign rubric → **422**, a partial binding → **422 `invalid_binding`** | a client must not widen the serving policy or choose its own rubric |
| no refused binding leaves an attempt behind (fingerprint unchanged) | a refusal that writes is not a refusal |
| omitting the binding still uses the default | an existing caller does not break |

The serving policy is applied **in the datastore** (`adapter.create` queries `task_version` joined to
`content_version` under the same `B1PREP_SERVE_REVIEW` policy as the catalogue route, and requires the
task's own rubric), and the memory fixture mirrors it — a rule enforced in one backend and not the other
is a test-only disagreement. The shipped client (`owned-client.js`) gained the same four optional fields
with all-or-none validation, and `public/app/api.js` gained the `writing` group.

**The screen.** `openWriting()` in `public/app/app.js`, in the SHELL's stylesheet layer (never in the
pinned `assets/design/hatoove.css` — `design-check` D1/D2 enforce that and the pin stays byte-exact):
attempt → debounced autosave against a revision → `Abgeben` → result polling, with the honest states:

* **queued/running** → "Die Bewertung läuft — bis dahin gibt es keine Punktzahl."
* **failed** → "**Unbewertet.**" plus `failure_code`, the text preserved, and a retry
* **succeeded** → the formative comment the server actually sends, labelled as formative, with **no
  total, no /45, no pass line, and no invented criteria list**
* **a 409 on autosave** adopts the server's revision and saves again rather than discarding the text

**Rendered evidence — and a defect the screenshot found.** Seven browser legs (W1–W7) with screenshots at
desktop and phone widths: 71/71 (was 63). The FIRST version of the submitted-state leg asserted only that
the state element had TEXT, and it passed while the state sat **below the fold** — the learner pressed
"Abgeben" and saw nothing happen. That is the third occurrence of this project's own recorded lesson
(*"the element is present" is not "the learner can see it"*). Both sides were fixed: `say()` now takes a
`reveal` flag that scrolls the state into view **on a learner action only** (never on an autosave
announcement, which would yank the viewport while someone types), and **W6** asserts the state's bounding
box is inside the viewport — it reports `top=845px of 900px`.

**STILL UNPROVEN, and not claimed:** the worker returns `{feedback, modelVersion, promptVersion,
rubricVersion}` — ONE comment — while `WRITING_RUBRIC` declares four criteria. Per-criterion feedback is a
rubric contract decision (R11) the server does not deliver, so the view renders what exists and says it is
formative. Rendering four criterion rows from one comment would be showing a rubric result nobody
produced. That remains a gap for the next writing slice, together with the listening view (no audio).

### 2 October 2026 — SPA-RETIRE 6: the legacy API is DELETED, and two lessons that cost real time

**Deleted from `server.js`:** `GET /api/config` and `POST /api/config` (plus their hosted-mode gate),
`POST /api/ai`, `POST /api/ai/test`, and every helper they were the last user of — `publicConfig`,
`saveEnv`, `callDeepSeek` and its `ApiError`, `validateAiRequest`, the `AI_*` bounds, `aiTestRefusal` and
its operator-token machinery, the `identityRequired` flag, and the now-unused `timingSafeEqual` import.
**No HTTP route in `server.js` can reach the provider any more.** The learner's exam date is
`GET/PUT /api/v1/settings`, per account; the provider is operator environment configuration; assessment is
a server-side worker job.

**Asserted absent, not merely ungated:**

| Where | What it asserts |
|---|---|
| `retired-surface-check` **R8** | no `pathname === '/api/config'`, `'/api/ai'` or `'/api/ai/test'` handler literal in `server.js` |
| `retired-surface-check` **R9** | `provider_config_is_operator_only` exists nowhere in `server.js` — the route is deleted, not gated |
| `docker-stack-check` | all three answer **404 to an AUTHENTICATED caller** — the difference between "gone" and "merely rude" (bodies are deliberately empty so a mounted legacy AI handler would 422 rather than start a provider call) |
| `api-spec-check` | `S-absent` (no path key) **and** `S-recorded` (the removal is recorded) for `/api/progress`, `/api/config`, `/api/ai` |
| `docs/openapi.yaml` | the paths are removed; the removal and its reasons are recorded in a comment |

**Anonymously this is invisible, and that is by design:** every `/api/*` path answers **401** to a caller
with no session (only `/api/health` and `/api/ready` are public), so the negative check works from source
literals and the authenticated assertion works with a session.

**LESSON 1 — the over-cut that only EXECUTION caught.** The cleanup script's first run removed five
runtime helpers it was not aimed at (`sendJSON`, `readBody`, `readJSON`, `requestIdentity`, and
`LOOPBACK_HOSTNAMES`) because an end anchor of `async function handleApi(` swallowed everything between.
`node --check` passed — a syntax check cannot see a missing function — and so did a regex "proof" that the
survivors were present. `retired-surface-check` caught it by **booting the server**
(`ReferenceError: sendJSON is not defined`). The second attempt left an orphaned doc comment open, which
turned the rest of the file into a comment: `node --check` was happy again, and the regex "proof" matched
**commented-out** text. Both failures argue the same thing, and it is the ledger's own rule: a check that
PARSES is not a check that RUNS. The script now strips comments before asserting, refuses to write unless
every survivor is defined and every deletion is confirmed, and the caller boots the server.

**LESSON 2 — a check can survive a deletion by driving a URL instead of a module.** Round 5 deleted the
SPA by finding references to its files; **`tools/mock-outcome-browser-check.mjs` was missed** because it
never named a module — it navigated a browser to `/`, which used to be the SPA and is now the **brand
landing page**. It would have reported on the landing page while claiming to test the mock-exam view. It
is deleted here, completing the row that had already recorded its replacement as unwritten, so its
properties are recorded as **UNPROVEN** rather than covered:
**P1** (an unavailable assessment renders `unbewertet`, never a fabricated score), **P2** (submitted text
stays accessible) and **P3** (no pass/grade-band/readiness claim) all need a writing-result screen before
they can be judged again. **P4** (no horizontal overflow) is void with the deleted view.

**Retargeted rather than deleted — and two of them had been STALE, not merely newly broken:**

| Check | Was | Now |
|---|---|---|
| `saas-runtime-check` — five AI-route legs | asserted `/api/ai` refuses anonymous, cannot override the model, is bounded, and `/api/ai/test` is operator-only | **RETIRED as VOID**: the routes do not exist. The property is structural and asserted in R8/R9 and the authenticated 404. The ledger forbids keeping an implementation alive to feed a check; the reverse is the same rule |
| `saas-runtime-check` — `legacy-progress-refused-anonymous-in-saas` | required **403 `legacy_progress_disabled`** from GET/POST/DELETE | **RETARGETED**: the token is one R1 asserts must exist NOWHERE, so this leg had been failing since the file store was removed. Now asserts 401/404, no record served, no token, no file written |
| `saas-runtime-check` — `runtime-database-interruption-is-a-refusal` | its last assertion demanded 403/503 from the legacy path | accepts 401/403/404/503: every one is a refusal, none serves a record |
| `saas-runtime-check` — `configured-public-origin-accepted-and-foreign-refused` | required **404** from anonymous `POST /api/config` | accepts 401 **or** 404 and forbids 200: anonymously the two are indistinguishable, which is why the authenticated assertion lives in `docker-stack-check` |

`saas-runtime-check` was **3 passed / 8 failed** before this slice and is **6/6** after it. The five-leg
retirement and the three retargets are in one commit with the deletion, so no leg was ever asserting a
route that did not exist.

### 2 October 2026 — SPA-RETIRE 5: the two red-at-HEAD checks are RETARGETED, not deleted

`server-origin-check` (7 of 16 legs red) and `keymask-check` (5 of 12 red) had been failing **at HEAD**
since the auth wrap landed, for one shared reason: both drove the legacy `/api/config` route anonymously,
and the wrap answers **401 before any handler**. CI never reported either, because each sits behind a
failing step in the same job. Neither check was wrong about its property — both were wrong about the
surface. Getting them green required MEASURING the real gate order, and the measurement contradicted my
first two assumptions:

| What I assumed | What the server does | How it was found |
|---|---|---|
| identity runs before everything on `/api/*` | on the legacy `/api/config` route the ORIGIN gate and the BODY gate run first: a foreign Origin gets `403 origin_rejected` and `text/plain` gets `415 json_required` with no session at all | leg failed with the actual status, twice |
| the owned `/api/v1/*` surface checks identity first, then origin | for a MUTATING request the origin gate answers first there too — foreign Origin, `null`, rebinding Host, foreign Referer, or NO Origin at all is `403 origin_rejected`; only a same-origin request reaches identity | second and third measurements |
| only a foreign Origin is refused | an ABSENT Origin is refused as well: "same-origin or nothing" | third measurement |

**`tools/server-origin-check.mjs` — RETARGET (8/8 green, was 7/16).** Legs now assert the two orders
explicitly: the legacy route's origin and body gates, its 401 for same-origin writes, and the owned
surface's "no Origin, no method, no 2xx" including the `404 Unknown endpoint` it returns here because this
check runs with **no account configuration**. Its test suite is 10/10.

**`tools/keymask-check.mjs` — RETARGET (14/14 green, was 5/12).** The property is unchanged — no
character run of the key in any response — and it is now scanned over **every response an anonymous
caller can obtain**: `/api/health`, `/api/ready`, the front door (18 KB of HTML), `/signin`, and the
refusals themselves. The old `leakScanText`/`leakScanJson` helpers insisted on a 200 with a JSON body,
which is exactly right for a read route and useless for a refusal; the new `scanAny` scans text always
and JSON where present.

**Discrimination, explicitly.** `keymask-check --prefix-commit 8a71f718` runs the SAME probe against the
pre-fix server and fails **5/5** leak legs while the key is live (`Zq7, q7X, 7Xv, 4Ew, Ew6` — the pre-fix
`keyMasked` pill — plus the pre-fix field set `baseUrl, configured, examDate, keyMasked, model`). This is
the mechanism the ledger required after `keymask-check.test.mjs` was deleted with its SPA fixture: the
retarget carries its own discrimination proof, and it is a CI step. Two supporting changes were needed:
the "key is live" anchor leg had to stop asserting the refusal (or it fails on the pre-fix source and the
judge cannot see a live key), and `LEAK_CHECKS` had to list only the legs that CAN fail there — the
pre-fix server 404s `/api/ready`, `/` and `/signin`, so demanding failure on those is unsatisfiable.

**Two defects found while retargeting, both fixed here:**

* **The probe would have made a live provider call.** Scanning `POST /api/ai` is harmless on the current
  tree (a 401) but the same probe runs against the PRE-FIX server, where an accepted request starts a real
  outbound call. A before/after probe is not a reason to break the no-live-AI rule, so `/api/ai` is not
  probed; the route is covered by `docker-stack-check` against the configured runtime. This also removed a
  Windows teardown crash (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, a fail-fast that made
  the prefix leg exit `0xC0000409` with every check green), which is why the close path now calls
  `server.closeAllConnections()`.
* **`api-spec-check`'s `/api/progress` leg was `text.includes('/api/progress')`.** It went red the moment
  the spec recorded the REMOVAL in a comment — a spec forbidden to name a retired route cannot record that
  it was ever there, and losing that record is its own defect. The leg now tests for a **path key**
  (`/^ {2}\/api\/progress:/m`) and, in the same breath, requires the removal note to be present
  (`S-absent` + `S-recorded`, 26/26 green).

### 2 October 2026 — SPA-RETIRE 4: the retired client itself, and the twenty-two checks that tested it

Ron: *"we need to remove the SPA as well to avoid this happening again."* The reason was demonstrated
twice while getting here: `public/js/progress-merge.js` could not be deleted because the browser-side store
imported it, and six checks used SPA modules as **fixtures**, so every retirement was entangled with the
client. **Nineteen modules and twenty-two tool files are deleted in one commit.** What survives in
`public/js/` is exactly one file: **`owned-client.js`**, the owned API client (driven by `owned-api-check`
28 legs on two backends, `owned-client-check` 31, `accounts-http-check`).

**A warning about this list.** `tools/check.js` (101 assertions) is gone, and it was the programme's
recorded "legacy offline baseline" (`AGENTS.md`, `README.md`). The baseline is smaller now and it is
DIFFERENT, not merely trimmed: the legacy assertions died with the engine they tested. The surviving
runner gates are `repository-check`, `design-check`, `retired-surface-check`, `server-origin-check`,
`keymask-check` (×2), `owned-api-check` (memory), `owned-client-check`, and the PostgreSQL job's
`postgres-provision-check`, `accounts-http-check`, `owned-api-check --backend=postgres-persistent`,
`deletion-check`, `worker-runner-check`, `saas-runtime-check`, `table-class-check`, `journey-api-check`.
Rendered evidence is `app-browser-check` (Docker + browser, developer-run) and Compose acceptance is
`docker-stack-check` (developer-run) — **neither is a CI gate**, which is recorded in `ci.yml` itself.

| Check(s) | Leg(s) | Property | Decision | Replacement |
|---|---|---|---|---|
| `public/js/**` except `owned-client.js` — account, ai, app, blueprint, dashboard, draft-session, engine, exam, generators, guides, icons, mock-outcome, satzbau, shell, speech, store, ui, writing-surface, progress-merge | — | the retired Certa client: its engine, its generated exercises, its blob store, its UI, its speech, its sentence analyser, its writing editor and its mock-exam view | **DELETE** (implementation removed) | the new client `public/app/**` (rendered evidence: `app-browser-check` 63 legs) · the owned API (`owned-api-check` 28 legs on memory AND postgres) · the server (`docker-stack-check` 32 legs) · the negative check (`retired-surface-check`, which now asserts the whole client is absent: R4b module gone, R4c `public/js` holds only `owned-client.js`) |
| `tools/check.js` | 101 | the legacy engine's rules: points, tags, generators, satzbau, speech, progress merge, plan ticks | **DELETE** | none — property void with the engine. **The recorded baseline changes shape; this row is the record** |
| `tools/writing-check.js` (9) · `tools/feedback-check.js` (14) | 23 | the client-side writing grader's coverage rules and feedback validation | **DELETE** | the grader that ships is the server's (`server/owned-postgres/worker.mjs`), held by `worker-runner-check` (claim/fence/retry/reclaim) and `docker-stack-check` leg 19 (server-side marking). The RULES themselves — 4 internal criteria, never relabelled as telc's three — are held by `owned-api-check`'s rubric assertions and the seeded `WRITING_RUBRIC` |
| `tools/mock-outcome-check.mjs` (+test) | 19 | `assessMockWriting` never fabricates a score | **DELETE** | void: the mock-exam view was SPA-only. The rendered half was already recorded UNPROVEN between MFP-08 and this commit; it stays UNPROVEN until a writing result screen exists |
| `tools/app-shell-check.mjs` | S1–S5 | the SPA shell: entry gate, Hatoove branding, no "Certa", no legacy modules, real endpoints | **REPLACE** | `app-browser-check` (the shell IS rendered there, with `L1c` on refused assets, `L9` on a clean console, `L30` on web storage) and `docker-stack-check` leg 22 (the gate and the public front door) |
| `tools/session-boundary-check.mjs` | 19 | server-side ordering/identity + the client-side session boundary (account copy, late responses, single-user path, second tab) | **server half REPLACE; client half DELETE** | **server:** `owned-api-check` legs `identity-is-never-accepted-from-input`, `unauthenticated-requests-get-401`, `cross-owner-is-404-for-every-route`; `deletion-check` (post-deletion 401s). **client:** void — the new client keeps no client-side record at all, which `app-browser-check` **L30** asserts |
| `tools/writing-surface-check.mjs` (+test) | 7 | the draft/revision/submission contract from the editor's side | **API half REPLACE; editor half UNPROVEN** | **API:** `owned-api-check` `draft-revision-checked-and-increments-once`, `submission-idempotent-on-owner-and-event`, `submission-snapshot-immutable`, `result-never-regrades`. **Editor:** a failed save not dropping the text, restore-on-return, debounce — **no vehicle until the writing UI exists**, and recorded as a gap rather than as coverage |
| `tools/draft-session-check.mjs` (+test) | 18 | the client draft state machine: reload recovery, conflict adoption, sign-out dropping text, late-response fencing | **API half REPLACE; client half UNPROVEN** | as the row above, plus `owned-client-check` 31 legs for client-side validation and shape refusal |
| `tools/content-discovery.mjs` | 9 areas | the C-01 content inventory | **DELETE** | its findings live on as `docs/content/DISCOVERY.md`; the tool read `public/js/ai.js`, which is gone |
| `tools/wo02-verify-probe.mjs` | — | a one-off probe for the mock-outcome slice | **DELETE** | none — property void |
| `tools/e2e.js`, `tools/e2e-ai.js`, `tools/ai-live.js`, `tools/tts-check.js`, `tools/mock-deepseek.js` | — | SPA end-to-end runs, a LIVE provider probe, a browser-TTS diagnostic, and their mock provider | **DELETE** | rendered journeys → `app-browser-check`; server journeys → `docker-stack-check`. The live-AI probe also goes because **no live provider call is authorized** in this programme — removing it removes a foot-gun. `tools/cdp.js` (the CDP harness) STAYS: it drives a browser, not the SPA |
| `tools/redesign-check.js`, `tools/writing-browser-check.js`, `tools/feedback-browser-check.js` | — | the SPA page's redesign, writing and feedback surfaces | **DELETE** | `app-browser-check` legs for the same screens |
| `tools/keymask-check.test.mjs` | mutation fixtures | the keymask probe discriminates | **DELETE** | its fixture read `public/js/ui.js`. `keymask-check.mjs` itself is KEPT and is one of the three red-at-HEAD checks; **its retarget must carry its own discrimination test**, which this row requires rather than assumes |

### 2 October 2026 — SPA-RETIRE 3: the provider-config check, and a live defect it had been failing to catch

| Check | Leg(s) | Property | Decision | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|
| `tools/provider-config-check.mjs` (**CI step removed**) | all 11 | a learner cannot set the provider or the model, no route discloses a key-derived field, and the Settings view offers no provider field | **REPLACE** | see below — and the property was FALSE when this row was written | this commit | SPA-RETIRE 3 |

**The check was red, and it was red for a reason that hid a real defect.** It drove `/api/config`
anonymously and expected 200/403; the auth wrap added to `server.js` answers **401 before any handler**,
so 7 of its 11 legs had been failing since that wrap landed. CI never reported it: it sat behind
`Same-origin guard on state-changing routes` in the same job, and a step after a failing step is
**skipped**. Measured against a clean `HEAD` worktree before this slice — identical numbers — so this
was pre-existing, not a regression.

**While writing its replacement, the property turned out to be FALSE.** `SETTINGS_FIELDS` contained
`model` on the server AND in the shipped client, and `validateSettings` wrote it to the database — so any
holder of an account could set the model through `PUT /api/v1/settings`, in both request shapes. Nothing
read it back for provider selection (the provider's model comes from operator configuration), so it was a
field that only LOOKED like it controlled the model. Fixed in the same commit: removed from the server's
field list, from the PostgreSQL settings port (validation, defaults, read mapping and the INSERT), and
from the shipped client's list. The list now has ONE server-side definition (`owned-api.mjs` exports it;
`settings.mjs` imports it) instead of two that could disagree.

**Replacement, with its discrimination measured:**

* `tools/owned-api-check.mjs` leg **`model-is-not-a-learner-setting`** — the client refuses it locally,
  and the SERVER refuses both shapes with 422 while a legal field travelling in the same payload is left
  unwritten; the legal fields still save. Run on **both backends** (28/28 memory, 28/28 postgres).
  Discrimination proven by restoring `model` to the field list and re-running: the leg goes **red**.
  *A lesson worth keeping:* the first version of this leg asserted only "422" for `{settings: {model}}`,
  and it passed **with the defect present** — because `validateSettings` also refuses a patch that
  resolves to no fields at all, so the assertion held for two different reasons. A rejection assertion
  must use a payload whose only OTHER outcome is success.
* `tools/app-browser-check.mjs` leg **L31** (the settings screen offers no provider, key or model field).
* `tools/keymask-check.mjs` for the key-disclosure half (its own retarget is still pending — it is one of
  the three red-at-HEAD checks).

**Gap carried, not hidden:** `/api/config` answering 404 to an AUTHENTICATED caller is not asserted
anywhere yet. It belongs with the retirement of the legacy `/api/config`, `/api/ai` and `/api/ai/test`
routes themselves, which is the next slice after the SPA's modules are gone.

### 2 October 2026 — SPA-RETIRE 2: the two checks that could be retargeted before the modules go

`public/js/**` cannot be deleted in one step: six surviving checks use SPA modules as **fixtures** (the
pin table is in `AUTORUN-QUEUE.md`, measured to the line). Two of those pins are now gone, both by
retargeting rather than by weakening.

| Check | Leg(s) | Property | Decision | Replacement / change | Commit | Slice |
|---|---|---|---|---|---|---|
| `tools/owned-api-check.mjs` leg `content-seed-matches-the-client` | 1 leg, 26 assertions | the seeded writing prompts and rubric are the SAME content as the client module that originated them | **RETARGET** | renamed `content-seed-and-the-seeded-migration-agree`: it now compares the fixture module against **migration 0006**, the artifact that actually seeds the database. This is not self-comparison — two different files, written at different times — and it catches the failure that matters (the database serving one text while the test path exercises another). The comparison against `public/js/ai.js` is void with that module. Green: 27/27 memory | this commit | SPA-RETIRE 2 |
| `tools/design-check.mjs` | rules 1–5 (raw colour, raw face, required tokens, breakpoints, shell/nav pattern) | the design language is consistent: no raw colour in a rule, no un-tokenised face, the tokens exist, the breakpoints exist, one navigation pattern | **RETARGET** (subject changed) | it read `public/styles.css`, the retired client's stylesheet, so the stylesheet could not be deleted while the check lived — an implementation kept alive to feed a check, which this ledger forbids. It now reads the shell's own layer `public/app/app.css` against the pinned `hatoove.css`: D1 raw colour, D2 raw face, **D3 every `var(--token)` used is DEFINED** (silent by nature), D4 the pinned system supplies what the shell uses + still carries dark theme, D5 the shell uses the system's breakpoint, D6 every route has a `#view-*` element, D7 one navigation pattern with `aria-current`. `public/styles.css` is DELETED in the same commit. Discrimination measured, not assumed: D3 goes red when an undefined token is added, D6 goes red when a view id is renamed. 14 passed / 0 failed | this commit | SPA-RETIRE 2 |
| the old design check's form-language advisory | 1 advisory over `public/js/{guides,blueprint}.js` | the explanation-language setting does not translate exam content | **REPLACE** | void as written (both modules go with the SPA); the property now has a browser vehicle that can actually fail — `tools/app-browser-check.mjs` **L32** asserts every nav label is identical before and after a real language change | previous commit | SPA-RETIRE 1 |

**A REAL GAP FOUND BY THE RETARGET, not by reading:** the pinned design system transitions `.btn` in
150 ms and carries **no `prefers-reduced-motion` block at all**. The pinned file is read-only, so the
neutraliser now lives in `public/app/app.css` and D4c fails if it disappears.

### 2 October 2026 — the file-based progress store (PILOT-17a, the stage that fits)

`server.js` carried the single-user store: `PROGRESS_PATH`, a `.rev` marker beside it, an
`x-b1prep-account` HEADER as the account selector, and `/api/progress` GET/POST/DELETE with an atomic
write, a one-generation backup and a revision race guard — about 350 lines, removed in one commit. It was
attributed by a HEADER rather than a session and fell back to ONE SHARED record when the header was
absent, which is why hosted mode answered its own refusal code instead of serving it. A file store also
cannot exist where the filesystem is ephemeral (Ron, 2 October 2026: the operator's provider key comes
from `.env` or the platform's environment variables), so the removal is a portability fix as well.

**The negative check exists now:** `tools/retired-surface-check.mjs` — *"no `/api/progress` route, no
progress file opened"*, promised in this file twice and written at last. It was run BEFORE the removal and
was RED on the three legs that observe it, which is the discrimination this ledger demands. It needs no
database, no browser and no Docker, so it is a CI step on any runner, and it fails if the handler, the
refusal code, the file write, the server-side import or a client path to the store comes back.
`tools/docker-stack-check.mjs` asserts the half that needs a session: an AUTHENTICATED GET/POST/DELETE
`/api/progress` answers **404**, because the auth wrap makes an absent route indistinguishable from a
refused one to an anonymous caller.

| Check | Leg(s) | Property | Decision | Reason | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|---|
| `tools/progress-equal-check.mjs` (+ `.test.mjs`) | all 10 | `progressEqual` compares two progress blobs independent of key order | **DELETE** | its subject is the retired blob: the assertions drive `/api/progress` over HTTP and it went red the moment the route did (measured: 2 of 10 failed). The FUNCTION still exists for the browser-side legacy store and retires with the SPA | `tools/retired-surface-check.mjs` (`R1`–`R4`) for the route and the file; the blob's remaining life is the SPA removal | this commit | PILOT-17a |
| `tools/progress-scope-check.mjs` (+ `.test.mjs`) | all 7 | the blob store is account-scoped | **DELETE** | the store it scopes is gone (measured: 4 of 7 failed after the removal). The heading it belonged to — one learner's records must not reach another's — is now a SERVER property, held by RLS and the owned attempt routes, and a CLIENT property, held by the leg below | **client half:** `tools/app-browser-check.mjs` leg `L30 the client kept NOTHING in web storage across the whole journey` — stronger than the property it replaces: there is no client-side blob left to scope. **server half:** FORCE RLS in `owned-api-check.mjs` and `deletion-check.mjs`, already green | this commit | PILOT-17a |
| `tools/reset-check.mjs` (+ `.test.mjs`) | all 8, incl. the pre-fix discrimination | a delete really deletes, and a late write cannot resurrect it | **DELETE** | measured 6 of 8 failed after the route left. The owned equivalent was written FIRST, as this ledger requires | `tools/owned-api-check.mjs` leg `delete-is-a-tombstone`: delete → tombstone recorded → read, stale `saveDraft`, submit, read-result, retry, re-create and a second delete all answer 404; plus `tools/deletion-check.mjs` lines 359–368 (after account deletion the cookie is 401 and a repeated DELETE changes nothing) | this commit | PILOT-17a |
| `tools/revision-check.mjs` (+ `.test.mjs`) | all 8, incl. the pre-fix discrimination | a reset invalidates writes that left before it | **DELETE** | measured 6 of 8 failed after the route left; same owned replacement as the row above | as above | this commit | PILOT-17a |

**What kept its file on purpose.** `public/js/progress-merge.js` was NOT deleted here, and the check says
so in a NOTE leg rather than pretending: it is imported by the BROWSER-side legacy store
(`public/js/store.js`), which eleven checks still drive, so deleting it now would cascade through the SPA
removal instead of this slice. It has no server-side caller and no route; it goes with the SPA.

**Also changed in the same commit, because the route's absence is documented state:**
`docs/openapi.yaml` no longer documents `/api/progress` (a spec that names a deleted route is how one
comes back), and `tools/api-spec-check.mjs` now asserts its ABSENCE where it used to require its presence.

### 2 October 2026 — the four SPA browser checks, and the CI job that ran them

The **Rendered behaviour (headless Chrome)** job is deleted, not emptied. All four of its steps drove the
retired Certa client, whose page is no longer served at `/` (the front door is the brand site), so the job
could not have passed; and a job whose only remaining step is a checkout would report GREEN for having done
nothing — the failure mode this file already records once, one level up. Their properties did not vanish:
their vehicles did, and every one now has a named home. **Nothing in CI renders the client today** —
`tools/app-browser-check.mjs` needs Docker and a browser and is a developer-run gate; that trade is
recorded here rather than implied.

| Check | Leg(s) | Property | Decision | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|
| `tools/provider-config-browser-check.mjs` | 13 | the Settings view offers no provider field | **REPLACE** | `tools/app-browser-check.mjs` **L31** — enumerates the new settings screen's fields (exam date, explanation language) and its text against provider / key / model, so a field or a label that names one fails the leg. Green and discriminating: it fails if such a field is added | this commit | SPA-RETIRE |
| `tools/account-ui-browser-check.mjs` | 25 | the explanation-language setting does not translate the German menu (also: no learner state in web storage, theme handling) | **REPLACE** | **L32** — reads every nav label before and after a real change through the real form, requires them identical, requires the shell to stay `ltr` when Arabic is chosen, and requires the Arabic option to carry `lang`/`dir`. **L30** covers the web-storage half. L32 found a real defect while being written: the topbar kept saying "Erklärungen: Deutsch" after the change until a navigation, now fixed and asserted | this commit | SPA-RETIRE |
| `tools/session-boundary-browser-check.mjs` | 70 | a second tab cannot re-create the account record | **server half KEEP (new vehicle); client half DELETE (property void)** | **server:** `tools/deletion-check.mjs` — after account deletion the cookie is 401 on account and attempt reads and a repeated DELETE changes nothing (green). **client:** void, because the new client holds no client-side record at all — **L30** asserts exactly that | this commit | SPA-RETIRE |
| `tools/writing-surface-browser-check.mjs` | (a) an account draft restores; (b) the single-user path is untouched | (a) a saved draft comes back; (b) local mode is untouched | **(a) UNPROVEN; (b) DELETE** | (b) the single-user path is gone. **(a) has NO vehicle until the writing surface exists in the new client** — the same honest gap this file already records for MFP-08, and the reason `writing-surface-check.mjs` (node level) is KEPT for now: it holds the draft/revision contract at the API level, which is the half that can still be tested | this commit | SPA-RETIRE |

---

### Earlier retirements

DOCKER-ONLY-01 retires tools/local-bringup-check.mjs with tools/local-bringup.mjs. Its host process/container orchestration is removed, not counted as a pass. The persistent-server properties (migrations, restricted roles, seeded catalogue, idempotency, readiness, worker and account persistence) are retargeted to the isolated Compose acceptance recorded in DOCKER-ONLY-01.md. Full product-journey acceptance remains pending and is not claimed by a server bring-up test.


| Check | Leg(s) | Property | Decision | Reason | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|---|
| `tools/mock-outcome-browser-check.mjs` (**CI step removed**) | `no-fabricated-score-when-unassessed` (P1), `submitted-text-stays-accessible` (P2), `no-pass-or-grade-band-claim` (P3), `no-horizontal-overflow` (P4) | **P1** — when the assessment is unavailable the writing shows as `unbewertet` and never a fabricated score. **P2** — submitted text stays accessible. **P3** — no "Bestanden?"/grade-band/readiness claim. **P4** — the mock layout does not scroll horizontally | **P1–P3 REPLACE; P4 DELETE** | The check spawns `node server.js` as a **local single-user** server (`mock-outcome-browser-check.mjs:115-126`, `B1PREP_PROGRESS_FILE`, no account configuration). The new direction **removes local single-user mode**, so the check cannot boot its server — this is the red `Rendered behaviour` job on PR #82. Keeping local mode alive to feed one check is exactly what the new direction ends | **P1–P3** → `tools/writing-result-browser-check.mjs` leg `failed-or-pending-assessment-renders-unassessed` (**slice MFP-08**, not yet written). **P4** → none; the mock view is deleted in MFP-11a | `MFP-00` (this row's commit) | MFP-00 |
| `tools/mock-outcome-check.mjs` (**KEPT**) | all 19, including discrimination against the pre-fix `exam.js` | `assessMockWriting` never fabricates a score | **KEEP** | It runs at the **node** level with no server and no browser, so removing local mode does not touch it. **It still guards P1–P3's logic** until the mock view itself is deleted | itself — CI step `Mock writing outcomes, discriminated against the pre-fix tree` (`.github/workflows/ci.yml` offline job) | — | — |
| **the remaining four browser checks** — `provider-config-browser-check`, `account-ui-browser-check`, `session-boundary-browser-check`, `writing-surface-browser-check` | all | various: Settings offers no provider field; the language setting does not translate the German menu; a second tab cannot re-create the account record; an account draft restores and local mode is untouched | **KEEP — see the correction below** | **CORRECTION, same day, by re-execution.** An earlier version of this row retired these four on the strength of a single CI failure of `provider-config-browser-check` and a probe showing they exercise the in-process single-user surface. **That conclusion was wrong and is withdrawn.** The probe's premise is right (`tools/coord-inprocess-surface-probe.mjs` does show `/api/ready` → `{ready:true, mode:"local"}`, `/api/config` → 200, `/api/v1/account` → 404), but the inference did not follow: **all four pass**, both locally on `2b0295e` (`provider-config-browser-check` → **13 passed, 0 failed**) and in CI, where the whole `Rendered behaviour` job is **green**. The single failure was a **flake on GitHub's runner**, and the honest reading is that the browser job is **fragile**, not that these checks are invalid. **A claim that four checks are invalid, made from one failure and a probe, is exactly the defect this ledger exists to prevent** — the same "code conditional, check unconditional" shape, one level up: **an inference unconditional in a record, drawn from evidence conditional on an environment.** They retire on the roadmap's schedule — MFP-07 (account-ui, provider-config), MFP-08 (writing-surface), MFP-11a (the rest) — with the negative check that matters being MFP-02b's `retired-surface-check`. **They stay in CI and stay gating until then** | themselves, until their scheduled slice | `MFP-00` (retired the row) / **`2b0295e` (withdrew it)** | MFP-00 |

### What we lose until MFP-08 lands, said plainly

**Rendered** evidence of P1–P3. The logic is still guarded by `mock-outcome-check.mjs` at the node level, but nothing
now proves that the *rendered* writing result refuses to show a fabricated score. That property is not abandoned —
it is **unproven between this commit and MFP-08**, and MFP-08 must write its replacement leg before the writing
result screen ships.

---

## Pending — identified, not yet executed

### MEASURED 2 October 2026: three of these are RED *now*, not "later"

`server-origin-check.mjs` (7 of 16), `keymask-check.mjs` (5 of 12) and `provider-config-check.mjs`
(7 of 11) all fail **on the committed tree**, and they fail for one reason: the auth wrap added to
`server.js` makes `/api/config` answer **401 `unauthenticated`** to an anonymous caller, while these
three still drive `/api/config` anonymously and expect 200/403. Verified against a clean worktree at
`HEAD` before this slice, with the SAME numbers, so this is not a regression from the file-store removal.

**CI shows only one of them.** The contracts job stops at `Same-origin guard on state-changing routes`, so
`keymask`, `provider-config`, `draft-session`, `owned-api` and `owned-client` are **SKIPPED** in the same
job and never report. The visible red is therefore smaller than the real red: a job that stops at its
first failure hides every step behind it. Read the step list, not the conclusion — `gh run view <id>
--json jobs | jq '.jobs[].steps[] | select(.conclusion=="failure" or .conclusion=="skipped")'`.

This makes the RETARGET rows below (server-origin, keymask, provider-config) the next repair after the SPA
removal, not a tidying task.

These were identified by the same review and are **not** retired yet, because their implementations are still
reachable. Each names the slice that retires it.

| Check | Leg(s) | Property | Decision | When | Replacement |
|---|---|---|---|---|---|
| `progress-equal-check.mjs` (+ `.test.mjs`) | all 10, incl. pre-fix discrimination | `progressEqual` compares two progress blobs independent of key order | **DELETE** | MFP-11a — the commit that deletes `public/js/progress-merge.js` and the blob | none — property void. The negative check that matters is MFP-02b's `retired-surface-check`: no `/api/progress` route, no progress file opened |
| `progress-scope-check.mjs` | all 7 | the blob store is account-scoped | **DELETE** | MFP-11a | MFP-07's `no-learner-state-in-web-storage` leg |
| `saas-runtime-check.mjs` | `legacy-progress-local-install-unchanged` | the local app is unchanged | **DELETE** | already retired by `SAAS-MODEL-01a` | `entry-point-fails-closed-when-the-mode-flag-is-omitted` |
| `saas-runtime-check.mjs` | flag-matrix legs (`B1PREP_SAAS` on/off) | two modes behave differently | **DELETE** | MFP-02b | `startup-refuses-removed-flags` + `missing-config-exits-before-listen` |
| `accounts-http-check.mjs` | `accounts-are-off-by-default` | absent config is safe | **RETARGET** | MFP-02b | absent config → process exits non-zero **before `listen()`** |
| `session-boundary-check.mjs` | legs that run "accounts off" | the single-user server path | **DELETE** | MFP-11a | the server-side legs (ordering, response fencing) stay; the client-boundary legs die with `account.js`'s single-user phase |
| `server-origin-check.mjs` | all 16 | a non-GET `/api/*` needs the same origin | **RETARGET** | MFP-02b | drive `PUT /api/v1/settings` and `POST /api/auth/sign-in/email` instead of `POST /api/config` |
| `provider-config-check.mjs` | all 11 | a learner cannot set the provider or model | **RETARGET** | MFP-02b | `/api/config` → 404; `PUT /api/v1/settings {"model":…}` → **422** (a new leg: `model` is still accepted today) |
| `keymask-check.mjs` | all 12 + pre-fix discrimination | no route discloses any 3-character run of the key | **RETARGET** | MFP-02b | route list becomes `/api/health`, `/api/ready`, `/api/auth/*`, `/api/v1/*`, static. The pre-fix discrimination commit `8a71f71` stays valid as a historical leg |
| `reset-check.mjs` (9), `revision-check.mjs` (8) | all | a delete really deletes, and a late write cannot resurrect it | **REPLACE**, then DELETE | MFP-02b | owned equivalent: `DELETE /api/v1/attempts/:id` then a stale `PUT` → 404, never a recreate; account deletion then a late write → 401. **Write the owned leg first**, in `owned-api-check` |
| `writing-surface-browser-check.mjs` | (a) an account draft restores; (b) "leaves the single-user path alone" | (a) a saved draft comes back; (b) local mode is untouched | **(a) RETARGET; (b) DELETE** | MFP-08 / MFP-11a | (a) becomes MFP-08's fresh-browser draft restore |
| `account-ui-browser-check.mjs` | 25 | the explanation-language setting does not translate the German menu | **RETARGET** | MFP-07 | the new shell: navigation strings identical before and after a language change (`RON-DECISIONS-20261001.md` §4.1) |
| `provider-config-browser-check.mjs` | 13 | Settings offers no provider field | **RETARGET** | MFP-07 | the new settings screen |
| `session-boundary-browser-check.mjs` | 70 | a second tab cannot re-create the account record | **REPLACE** | MFP-07 + `deletion-check` | the new client holds no learner state in `localStorage`; server-side, a late write after deletion → 401 |

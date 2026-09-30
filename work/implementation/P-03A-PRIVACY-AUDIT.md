# P-03A — read-only privacy and data-integrity audit of the merged tree

| | |
|---|---|
| Task / execution | P-03A / `privacy-audit-01-claude-20260930-a` (coordinator `COORD-TAKEOVER-20260930`) |
| Auditor | Claude for Windows (local), independent of the authors |
| Tree audited | `origin/main` @ `82ae9c28081893076243babd77ce21c1354496c2`, branch `codex/privacy-audit-01` |
| Method | Static reading of tracked files, `git grep` pattern scans over the tracked tree and all-refs file history, `node tools/repository-check.mjs`, plus one dependency-free Node reproduction that imports `public/js/progress-merge.js` with synthetic records (script kept outside the repo) |
| Not done | No server, browser, database, `.env`, provider call or real account. No application file was changed |
| Status | **This audit is input to the human P-03 security/privacy/legal gate. It does not approve anything or close any gate.** |

## Verdict

**Issues found.** I found no committed secret and no real learner record in tracked content. The audited areas contain:

| # | Severity | Finding |
|---|---|---|
| F-1 | **High** | The local server's unauthenticated API accepts cross-origin writes. A web page can redirect the stored DeepSeek key to a host it controls, and can use or corrupt the learner's data |
| F-2 | **Medium** | "Alles zurücksetzen" and "Fehlerheft leeren" do not delete anything. The monotonic merge restores the data on both server and client. Reproduced with synthetic data |
| F-3 | **Medium** | Learner free text goes to a third-party AI provider, and the app does not tell the learner. The Settings copy mentions only the key |
| F-4 | Low | Legacy persistence inventory: learner-derived text is stored as plaintext in `localStorage` and `progress.json`, with no account scope |
| F-5 | Low | Backup copies of progress, plus copies of the key on removable media, fall outside any deletion path |
| F-6 | Low (documented) | Attempt deletion in the auth spike is only logical. Submission text and assessments remain, and no account-deletion path exists |
| F-7 | Informational | Unauthenticated `/api/health` and `/api/config` show 9 characters of the key and the Node version |
| F-8 | Informational | Machine paths and the OS account name appear in tracked docs and scripts. They contain no credentials |
| F-9 | Informational | Secrets scan: no genuine secret. Each hit is classified as a placeholder or local-only default |
| F-10 | Informational | Tracked content is marked synthetic. I sampled it but did not read all of it |
| F-11 | Informational | Logging: no request logging or remote crash reporting. Error text that reaches the client and a startup banner are the only paths |

**The premise needs correcting.** The task describes an `OWNED-CLIENT-01` browser transport for `/api/v1/account`, `/api/v1/attempts` and `/api/v1/submissions`. That transport **is not in this tree**. `public/js/**` contains no reference to `/api/v1`, accounts, sign-out or `deleteAttempt`. The only callers of `/api/v1/*` are the spike tests (`spikes/auth-runtime/test.mjs`, `isolation.test.mjs`). Sign-out cache clearing, account-scoped caches and late-response isolation in the browser are **unimplemented**, so I could not audit them. `docs/contracts/PILOT-V0.1.md:15` says so: "This browser boundary is specified, not implemented in the spike." Nobody should read this audit as evidence that the owned-client boundary is safe.

There are two separate servers:

- **Legacy learner app:** `server.js` with `public/**`. This is what runs today on the learner's machine. Per `README.md:38,56`, the installed copy with a real key is outside this repo.
- **Auth/runtime spike:** `spikes/auth-runtime/**`. Local, synthetic-only, and not wired to the UI.

F-1 to F-5 concern the legacy app. F-6 concerns the spike.

---

## F-1 — Local API accepts cross-origin state-changing requests (key redirection, relay use, data injection)

**Severity: High** for the legacy app as it runs today on a learner machine with a configured key. This is conditional on browser behaviour I could not test (see "Not verified").

**Evidence**

- No check on Origin, Referer or Host, and no CSRF token, on any `/api/*` route: `server.js:459-473` routes straight to `handleApi`, and `server.js:346-457` never inspects headers.
- The request body is parsed as JSON **regardless of `Content-Type`** (`server.js:172-180`). A cross-origin `fetch(..., {mode:'no-cors', method:'POST', headers:{'Content-Type':'text/plain'}, body:'{...}'})` or an HTML form counts as a CORS "simple request". It is sent with no preflight, and the server acts on it. The attacker never needs to read the response.
- `POST /api/config` takes an unvalidated `baseUrl` (`server.js:408`) and saves it to `.env` (`server.js:117-134`). Every later provider call sends the stored key to that URL as a bearer token: `fetch(\`${s.baseUrl}/chat/completions\`, … Authorization: \`Bearer ${s.apiKey}\`)` at `server.js:295-300`, with `baseUrl` from `server.js:95`.
- `POST /api/ai/test` (`server.js:437-454`) and `POST /api/ai` (`server.js:415-435`) start that outbound call with no user action. `/api/ai` also passes through `model`, `maxTokens` and arbitrary `messages` (`server.js:418-425`), making it an open relay for the learner's provider credit.
- `.env` line injection: values are only `trim()`med (`server.js:406-409`) and are written as `${k}=${merged[k]}` lines (`server.js:131`). A value with an embedded newline adds extra `KEY=value` lines. `loadEnvIntoProcess` loads every key from `.env` at the next start (`server.js:78-83`), including `B1PREP_PROGRESS_FILE` (`server.js:29-31`). That lets the attacker choose where `writeProgress` renames its temp file on the next save (`server.js:185-196`), i.e. an overwrite of a user-writable file with progress JSON. It needs a server restart. I reasoned this from the code and did not run it.
- `POST /api/progress` accepts up to 16 MB (`server.js:362`). Because the merge is monotonic (F-2), anything an attacker injects, such as error-notebook entries with arbitrary text, becomes permanent and cannot be removed from the UI.
- Contrast: the spike server rejects non-GET requests without a matching `Origin` (`spikes/auth-runtime/server.mjs:22`) and requires `application/json` (`server.mjs:25`). It is tested at `spikes/auth-runtime/test.mjs:56-70`. The legacy server has neither control.
- The only control is the `127.0.0.1` bind (`server.js:488`). That stops other machines from connecting, but it does not stop the learner's own browser, which is how cross-site requests arrive.

**What an attacker or accident could do.** The learner has the app running (it stays running while they study) and visits a hostile or compromised page in the same browser. That page fires two blind POSTs. The first changes `DEEPSEEK_BASE_URL` to the attacker's host. The second, `/api/ai/test`, makes the server send the learner's real DeepSeek key to that host. From then on the learner's own writing and transcripts also go to the attacker, and the app appears to work normally until the key is rotated. More simply, a page can spend the learner's provider credit through `/api/ai`, or permanently pollute their progress record.

**Not verified.**

- Whether current browsers block these requests. Chromium's Private/Local Network Access work, Firefox and Safari differ by version. I ran no browser, so treat every browser as unprotected until someone tests it on the learner's actual browser and version.
- DNS rebinding: there is no `Host` check, so a rebinding attack might also *read* `/api/progress`. I did not test this.
- Whether a newline really survives the browser → `JSON.parse` → `.env` → restart path end to end. I did not run it.

---

## F-2 — Reset and "clear notebook" do not delete; the merge restores the data

**Severity: Medium.** It is an integrity and deletion defect, and it misleads the learner: the UI promises deletion and the data persists.

**Evidence**

- The reset button shows "Wirklich den gesamten Fortschritt löschen? Das kann nicht rückgängig gemacht werden." and calls `store.resetAll()` (`public/js/ui.js:1081-1086`).
- `resetAll()` replaces the in-memory state with `freshState()` and calls `saveNow()` (`public/js/store.js:276-281`). That POSTs the empty state to `/api/progress` (`store.js:159-167`).
- The server **merges** instead of replacing (`server.js:372-374`). `mergeProgress` is a union by design: history is a multiset union (`public/js/progress-merge.js:101-112`), error-notebook entries are unioned by id (`progress-merge.js:115-122`), and counters, nodes, SRS, days and plan ticks keep maxima or unions (`progress-merge.js:61-165`). The result still holds everything.
- Because the result differs from what the client sent, the server returns it (`server.js:379`). The client merges it back into memory and rewrites `localStorage` (`store.js:173-176`). The "reset" browser then holds the full record again.
- `clearErrors()` (`store.js:583-586`, called from `ui.js:520`) has the same problem: the server's copy keeps every entry by id.
- `DELETE /api/progress` exists (`server.js:387-396`), but **no client code calls it**. A `DELETE` search of `public/js/**` finds only this server route.
- **Reproduction** (synthetic, Node, imports only `progress-merge.js`). I started with a server record holding one history row and one error entry whose `yourAnswer` was a synthetic marker string. Then I ran the three steps above: server merge, `progressEqual` check, client merge-back. Result: `serverHistory: 1, serverErrors: 1, sendsBack: true, clientHistory: 1, clientErrors: ['SYNTHETIC-LEARNER-TEXT'], clientAttempts: 1`. For "clear notebook" (`errors: []` with a newer `updatedAt`), the merged result still had 1 error.

**What could happen.** A learner "deletes everything" before handing the machine or browser to someone else, or before starting fresh for a new exam date. Every attempt, the error notebook and the sentences from their own letters (F-4) survive in `progress.json` and reappear in the browser. Import (`store.js:287-298`) has the same union semantics, so importing a file adds to the data and never replaces it.

**Not verified.** I did not run the UI flow in a browser. The reproduction exercises the exact merge functions and call order read from `store.js`/`server.js`, but not the debounce timers or multi-tab timing.

---

## F-3 — Learner text is sent to a third-party AI provider without disclosure

**Severity: Medium.** It is a privacy and transparency issue. No account identity is involved.

**Evidence**

- What leaves the machine: all AI calls go browser → `POST /api/ai` on localhost (`public/js/ai.js:65-78`) → the provider at `DEEPSEEK_BASE_URL`, `https://api.deepseek.com` by default (`server.js:95`, `server.js:295`). Payloads include:
  - the learner's whole letter, up to 4,000 characters (`ai.js:909-923`);
  - the speaking transcript, up to 4,000 characters (`ai.js:1091-1102`);
  - a learner-typed sentence (`ai.js:1163-1172`);
  - the learner's drill answer (`ai.js:1217-1223`).
- No identity fields are sent. The legacy state has no name, email or account id (`store.js:28-53`), and the prompts contain task, text and analysis only. The **free text itself can hold personal data**, because B1 letters are personal by design (invitations, apologies, complaints).
- The provider key never reaches the browser. `/api/config` returns only a masked form (`server.js:100-115`), and the key is sent only server-side (`server.js:299`). **Pass on key exposure to the browser.**
- Disclosure: the Settings card says the key is stored only locally in `.env` (`public/js/ui.js:883`). Nothing tells the learner that their texts go to DeepSeek. `AI-Aufgaben im Drill` (`ui.js:944-948`) controls generated drills, not grading.
- Speech input uses the browser's `SpeechRecognition` (`public/js/speech.js:218-219`). The speaking view is still registered (`public/js/app.js:235`) although speaking is out of pilot scope. In Chromium-based browsers this recognition is generally server-side at the browser vendor, a second third-party flow the app does not disclose. That is vendor behaviour I did not verify. TTS voices can be "Netz-Stimme" (`ui.js:927-929`), but they send exam scripts, not learner text.
- No analytics, beacons, third-party scripts, fonts or CDNs load in `public/**` or `hatoove-site/dist/**`. Every external URL in those trees is a namespace, a licence link or a static `<meta>`/JSON-LD value.

**What could happen.** A learner writes a letter with real names, addresses or health details. The text is sent to, and possibly retained by, a provider outside the learner's control, and the learner was not told.

**Not verified.** The provider's retention, training use and jurisdiction terms. Whether any deployment points `DEEPSEEK_BASE_URL` somewhere else; the research used GreenPT (`research/deepseek-feasibility/RESULTS-2026-09-30.md:3`). Browser-vendor speech processing.

---

## F-4 — Persistence inventory (legacy app): learner-derived text in plaintext, single unscoped blob

**Severity: Low.** This is a local single-user app on the learner's own machine. It becomes relevant once accounts or shared devices exist.

**Browser persistence (complete for `public/**`)**

| Key / store | Where | Content and shape | Identifies a person or machine? |
|---|---|---|---|
| `localStorage['certa-theme']` | `public/index.html:13`, `public/js/app.js:157,166-179` | `'light'` or `'dark'`; removed for "system" | No. Informational |
| `localStorage['b1prep.state.v1']` | `public/js/store.js:18,69-77,122-142` | The whole progress object (`store.js:28-53`): `settings` (exam date, daily goal, TTS rate, `voiceName`, model, `writingTaskIndex`); `nodes`; `history` of up to 4,000 attempts (`store.js:449-462`); `errors` of up to 400 entries with **`prompt` ≤1200, `yourAnswer` ≤600, `correctAnswer`, `explanation`** (`store.js:542-566`); `srs`, `days`, `planDone`; `counters.lastAiError` ≤300 characters of provider error text (`store.js:685-693`) | No name, email or account id. **It does contain learner-authored text:** writing corrections put the learner's original sentences into `prompt`/`yourAnswer` (`public/js/exam.js:774-785`; mock at `exam.js:1125`, `exam.js:1428`), and drill wrong answers go in too (`ui.js:314,359`, `exam.js:519`). `voiceName` is a local OS voice name, a weak machine hint |
| `sessionStorage`, IndexedDB, cookies, Cache API, service worker | none found | — | — |

Full writing drafts are **not** persisted. They exist only in the textarea and in memory (`exam.js:596-679`, `exam.js:1394-1407`), so a reload loses an unsubmitted letter. That is an integrity gap for the draft-recovery work, not a privacy leak.

**Server persistence (legacy)**

- `progress.json` in the app root, or `B1PREP_PROGRESS_FILE` (`server.js:29-31`). It is the same object as above after merging (`server.js:372-374`), written as plaintext JSON with a one-generation backup `progress.json.bak` (`server.js:185-197`).
- `.env` in the app root (`server.js:23`, `server.js:117-134`) holds the provider key in plaintext, the model, base URL, exam date and port.

**Spike persistence (synthetic only):** PostgreSQL tables in `spikes/auth-runtime/schema.sql:2-46`. `drafts.text` (≤12,000 chars) and immutable `submissions.text` hold learner text. `user`/session tables come from Better Auth (`auth-schema.sql`) and hold email and password hash. `GET /api/v1/account` returns `{contractVersion,id,email}` to the owner only (`server.mjs:55`).

**What could happen.** Anyone with access to the OS account or browser profile can read the learner's mistakes and sentence fragments in plaintext. Once accounts exist, the single `b1prep.state.v1` key would be shared by every learner using the same browser profile. `PILOT-V0.1.md:88` already says new drafts must never go into this blob.

**Not verified.** How large real `localStorage`/`progress.json` files get, and whether other browser-level storage (autofill, form restore) keeps textarea content.

---

## F-5 — Backup and portable copies are outside every deletion path

**Severity: Low.**

**Evidence**

- `DELETE /api/progress` removes only `progress.json` and `progress.json.bak` (`server.js:389-390`). As F-2 shows, nothing in the UI calls it anyway.
- These copies are never removed:
  - `progress.json.pre-recovery`, written by `tools/recover-progress.js:90-92`;
  - `progress.json.before-ssd-sync-<id>.bak`, written by `tools/sync-home.js:145`;
  - a leftover `progress.json.tmp` after an interrupted write (`server.js:186-195`).
- `tools/build-portable.ps1:45-52` intentionally copies the learner's real `.env` (the provider key) and all `progress.json*` files from `D:\B1_Prep` into `.qa\portable-build\B1_Prep` for a removable SSD. It also writes the machine name to `sync-home.json` (`build-portable.ps1:40-43`). The output is gitignored (`.gitignore:1,5,8,10`), and AGENTS.md forbids committing bundles, so this is not a repository leak. It does mean the key and learner record travel unencrypted on removable media.

**What could happen.** Deleting progress, whenever that becomes possible, leaves several full copies on disk. A lost SSD exposes the key and the learner's record.

**Not verified.** Whether the SSD is encrypted, and how many backup generations exist on the real machine. I did not inspect `D:\B1_Prep` and was not permitted to.

---

## F-6 — Spike: attempt deletion is logical; no account deletion (already documented)

**Severity: Low (known and documented).** This is synthetic, local-only spike code with no production entrypoint (`spikes/auth-runtime/README.md`).

**Evidence**

- `remove()` sets `attempts.deleted_at`, cancels queued or running jobs, releases reservations and deletes the draft row (`spikes/auth-runtime/store.mjs:166-176`).
- **`submissions.text`, `assessments.feedback` and `usage_ledger` remain** (`schema.sql:19-26,37-46`). Submissions are protected against UPDATE by a trigger (`schema.sql:28-30`).
- Reads of a deleted attempt return 404 through `owned()` (`store.mjs:22-26`), so the data is hidden but retained.
- There is no account-deletion route. The allowlist is sign-up, sign-in, sign-out and get-session only (`server.mjs:10-11`). The foreign keys to `"user"` have no `ON DELETE` action (`schema.sql:3,13`), so deleting a user row would fail while attempts exist.
- Sign-out revokes the server session, and that is tested (`test.mjs:85-91`). There is **no browser-side clearing**, because there is no browser client (see Verdict).
- This is documented, not hidden: `docs/contracts/PILOT-V0.1.md:75` says "this is logical deletion testing, not privacy erasure" and assigns account deletion and physical purge to A-05.

**What could happen.** If this were promoted as-is, a learner who "deletes" an attempt would still have the full submitted text and feedback stored, and could not delete their account.

**Not verified.** I did not run the spike tests because they need PostgreSQL. I did not check Better Auth 1.7.6's own deletion or session-cleanup behaviour.

---

## F-7 — Masked-key fragment and Node version on unauthenticated endpoints

**Severity: Informational.**

`/api/health` (`server.js:349-351`) and `/api/config` (`server.js:398-401`) return `keyMasked`, which shows the first 5 and last 4 characters of the key (`server.js:100-104`), plus `node` (the version), `model`, `baseUrl` and `examDate`. The server sets no CORS headers, so other origins cannot read these responses unless DNS rebinding succeeds (F-1). Nine characters do not recover a key. They do confirm which key is in use. I did not verify rebinding.

---

## F-8 — Machine paths and OS account name in tracked files

**Severity: Informational.** No credentials, and the repository is private.

Absolute local paths that include the Windows account name and the OneDrive and D:/G: layout appear at:

- `DESIGN_NOTES.md:18,24`
- `IMPLEMENTATION_PLAN.md:41`
- `PILOT_BUILD_PLAN.md:70`
- `README.md:38,56,70,81`
- `docs/AGENT_WORKFLOW.md:13,15,29`
- `work/BOARD.md:47`
- `work/implementation/PRE-05.md:5`
- `work/implementation/USER-02.md:4`
- `work/implementation/USER-03.md:4`
- `work/implementation/USER-04.md:5`
- `research/deepseek-feasibility/README.md:46,49,72`
- `tools/build-portable.ps1:2`
- `tools/install-academy.ps1:2`
- `portable/README.txt:37`

The server also prints `PROGRESS_PATH` at startup (`server.js:497`), and failed saves can put a path in `err.message` sent to the client (`server.js:382`). These reveal the machine layout and the account name if the repository is ever shared. Whether they count as "machine configuration" under AGENTS.md is for the coordinator to decide. I am not recommending an edit here.

---

## F-9 — Secrets in the repository

**Severity: Informational. No genuine committed secret found.**

**Scans run.** Over all 245 tracked files:

- provider-key shapes (`sk-…`), GitHub, AWS, Google and Slack token shapes, JWTs, `Bearer …` literals, PEM private-key headers;
- `postgres://`/`mongodb://` URLs with credentials, `http(s)://user:pass@`;
- `api_key/secret/password/token/credential =` assignments;
- high-entropy runs of 40+ characters outside JSON, SVG and lockfiles;
- 1Password item references.

I also checked the file history across **all refs** for any `.env`, `progress*.json`, `sync-home.json`, `*.pem`/`*.key`, `research/*/runs/`, `.qa/` or `study-summary.json`. **None were ever committed.** `node tools/repository-check.mjs` passes ("245 tracked files; 174 text blobs screened").

**(a) Genuine committed secrets:** none.

**(b) Placeholders and documented examples (not leaks):**

| Location | What it is |
|---|---|
| `.env.example:4` | `DEEPSEEK_API_KEY=` is empty; the repository check requires it to be empty |
| `public/js/ui.js:890` | `placeholder="sk-…"` input hint |
| `tools/e2e-ai.js:10` | `DEEPSEEK_API_KEY=test` in a usage comment against a local mock |
| `tools/sync-home-check.js:52` | `fixture-only-private` written to a temporary test directory |
| `spikes/auth-runtime/test.mjs:21,51`, `isolation.test.mjs:21,51` | `alice@example.test`/`bob@example.test` and passwords from `randomBytes` at runtime |
| `research/mistral-feasibility/README.md:56` | `--op-item <item-id>` placeholder; no real vault item id is committed |

**(c) Local-only defaults:**

| Location | What it is |
|---|---|
| `server.js:95` | public provider base URL |
| `spikes/auth-runtime/auth.mjs:10` | passwordless `postgres` role on `127.0.0.1:55435` against a disposable `trust` container (`spikes/auth-runtime/README.md`) |
| `.github/workflows/pilot-contracts.yml:15-17` | `POSTGRES_HOST_AUTH_METHOD: trust` for an ephemeral CI service |
| `auth.mjs:13`, `test.mjs:10`, `isolation.test.mjs:12` | auth secret generated per run with `randomBytes(48)` |
| `research/*/run*.mjs` | keys read at runtime from stdin, 1Password (`research/mistral-feasibility/run.mjs:126-146`) or an explicitly named env file (`research/deepseek-feasibility/run-from-env.mjs:9-31`), with redaction before writing (`run.mjs:146`); outputs go to gitignored `research/*/runs/` |

**Comparison with `tools/repository-check.mjs`.** I agree with its result. Its coverage is narrower than a full audit:

- It checks five patterns (`repository-check.mjs:9-15`). It does not catch AWS/Slack/JWT shapes, `postgres://user:pass@` (the credential-URL rule only matches `http(s)`), or generic `KEY=value` assignments outside `.env.example`.
- It skips binary blobs.
- It inspects only the index, not history.

My wider patterns found nothing extra. PNG metadata was not inspected.

---

## F-10 — Learner data in tracked content

**Severity: Informational. No real personal data found in what I inspected.**

- `data/*.json` (10 files) are content packs: seed exercises, guides, vocabulary and lexicon, served statically (`server.js:225`). The email and machine-path scans returned nothing from them. I did not read them fully.
- `tests/fixtures/objective-marking-cases.json` cites official model-exam pages (`"source": "S2-p…"`). `tests/fixtures/writing-feedback-cases.json` is declared synthetic ("no learner data: every input is synthetic or a deliberately malformed provider sample", `docs/assessment/FEEDBACK-CASES.md:16-17`).
- `research/*/fixtures.json`, `heldout.json` and `register-diagnostic.json` are authored contrasts, as their `note` fields and `research/mistral-feasibility/RESULTS-2026-09-30.md:97` state ("no real learner data"). The RESULTS and semantic-review files quote or summarise **provider outputs on synthetic inputs**. That is derived provider content, but not a raw run and not learner data. Raw runs are gitignored and absent from history.
- `work/implementation/USER-02/evidence/*.json` (8 files) record viewport measurements from an isolated instance at `127.0.0.1:55437`, matching the isolation instruction at `USER-02.md:14`. They contain no file paths, user agents or state dumps.
- I viewed one screenshot (`before-D6-stats-1280x800-light.png`). It shows plausibly synthetic progress (118 tasks "today" while every section reads "noch nicht geübt") and no names. **I did not view the other 58 screenshots** or `docs/design/previous-learner-dashboard.png`. That file is a picture of the *previous learner dashboard* and could show the real learner's real progress figures. Someone should check it by eye.

---

## F-11 — Logging

**Severity: Informational.**

- **Legacy server.** There is no request logging. `console.*` is used only for:
  - the startup banner, which prints the masked key, exam date and progress path (`server.js:489-499`);
  - listen errors (`server.js:502-516`).

  No learner text, answers or ids are logged. Provider error bodies, up to 600 characters (`server.js:307-315`), and `err.message` go to the **client** in JSON (`server.js:382,428-432,451,481`). There they are shown and saved as `counters.lastAiError` (`store.js:690`, `ui.js:967`), so provider error text ends up in `progress.json`. Provider errors normally do not echo request content. I did not verify that for DeepSeek.
- **Browser.** Only `console.error` for uncaught errors (`app.js:266-271`, `shell.js:191`), which stays in local devtools. No remote crash reporting, telemetry or analytics.
- **Spike.** Better Auth is set to `logger: { level: 'error' }` with `telemetry: { enabled: false }` (`auth.mjs:20`). HTTP errors map to fixed codes and never echo the body (`server.mjs:71`). I did not verify whether Better Auth's error-level log lines can include an email address.
- **Provider side.** Whatever DeepSeek, or a GreenPT-style endpoint, logs about request bodies is outside this repository and unknown.

---

## What I could not determine without running things (honest gaps)

1. **Browser blocking of cross-site requests to loopback (F-1).** This decides whether F-1 is exploitable in the learner's actual browser. It needs a browser test against an isolated instance with a dummy key and a dummy `baseUrl` receiver.
2. **DNS rebinding** against `server.js`, which has no Host check.
3. **The reset flow end to end** in a real browser with real timing (F-2). The merge logic was reproduced; the UI, debounce and multi-tab paths were not.
4. **The owned-client browser boundary.** Sign-out clearing, account-scoped caches, late responses and two accounts in one browser profile cannot be audited because the code does not exist in this tree (`PILOT-V0.1.md:15,88`).
5. **Spike behaviour under PostgreSQL**, including Better Auth's session, deletion and logging. I did not run the spike tests.
6. **Third-party retention:** DeepSeek or GreenPT request logs, and browser-vendor speech recognition.
7. **What the installed `D:\B1_Prep` copy and any portable SSD actually hold.** These are out of bounds; the `.env` and progress files there are real.
8. **Image content.** Of 60 committed PNGs, one was sampled. `docs/design/previous-learner-dashboard.png` needs a human check.
9. **Full reading of `data/*.json` and the research fixtures** beyond targeted pattern scans.

None of these areas should be treated as safe because this audit found nothing in them.

## Suggested next actions (for the coordinator; not performed)

- F-1:
  - Before the next learner session with a configured key, add an Origin/Host allowlist and require `application/json` on all mutating `/api/*` routes, matching the spike's `server.mjs:22,25`.
  - Validate `baseUrl` against an allowlist and reject control characters in any value written to `.env`.
  - Rotate the key if there is any doubt.
- F-2: decide on deletion semantics (a tombstone or explicit reset generation the merge respects, or a real call to `DELETE /api/progress` with local clearing). Add a focused test that reset and clear-notebook survive the server round trip.
- F-3: add a plain-language notice at the point of AI grading, and in Settings, naming the provider and what is sent. Record the provider's retention terms for P-03.
- F-5/F-6: carry these into A-05 retention and deletion scope, including backup files and portable media.
- F-10: have a human look at `docs/design/previous-learner-dashboard.png`.

Report ends. Only file written: `work/implementation/P-03A-PRIVACY-AUDIT.md`.

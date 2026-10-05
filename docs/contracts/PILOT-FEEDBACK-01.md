# PILOT-FEEDBACK-01 — collect pilot feedback into a table

**Status: FROZEN by the coordinator, 5 October 2026 (23:05 +02:00).** Direction decided by Ron on
5 October 2026; the engineering contract is frozen here and leased as the bounded slices in §7. Every slice is
authored by one writer and reviewed by a non-author before integration.

**Base:** `main` @ `daaff6b` (the revision live in production).
**Applied migration head:** `0047`. **This contract's migration:** `0049-pilot-feedback.sql` (see A1).
**Authorisation:** Ron, in-session, 5 October 2026: *"we need to deploy this to prod as soon as possible as
without it we are not able to get user feedback"*, and *"use claude to help build this"*. Deployment of the
integrated result is authorised; nothing is published or deployed before the gates in §6 pass on the exact head.

## Ron, verbatim (5 Oct 2026)

> "we need a way to collect feedback from the pilot group possibly save it in a table"

> "a button on every question is overkill we need just a to report a problem"

> "include the page render" — clarified: attach a screenshot of the page the learner was on to each report.

## Amendment log

| # | Amendment | Reason |
|---|---|---|
| **A1** | The migration is **`0049-pilot-feedback.sql`**, not `0048`. | `0048-pool-01-listening-release.sql` already exists on `codex/pool-01-listening-release` and is pinned by filename in `server/migrations/MANIFEST.json` (`pool-01-check.mjs:589`). Numbering is by filename order, so a gap is harmless; renumbering a built, gated branch is not. Whichever branch lands second keeps the higher number. |
| **A2** | **Two deploy stages.** Stage 1 = FB-A + FB-B + FB-C: the learner-facing table, the API and the report form. Stage 2 = FB-D (operator CLI, the `__OPERATOR__` role, the survey seed) and FB-E (screenshots). | Ron's need is *collecting* feedback. Stage 2 holds the riskier surface: FB-D adds a **new login role**, and therefore a new secret in `production.env` and in the compose environment list — a production configuration change — while FB-E is the riskiest browser work. Stage 1 stays free of production config changes. **Consequence, stated honestly:** the survey card ships in Stage 1 but stays dormant until Stage 2's seed writes a round, so the card cannot appear on Heute before then. |
| **A3** | Named anchors (the draft named them by description only): RLS pattern `server/migrations/0015-item-evidence.sql`; deletion steps `server/owned-postgres/adapter.mjs:1738` (`ACCOUNT_DELETION_STEPS`); data export route `server/owned-api.mjs:1407` (`/api/v1/export`); throttle helper `server/owned-postgres/throttle.mjs`; catalogue `tools/lib/catalogue.mjs`; i18n catalogues `public/assets/i18n/{shell,practice,auth,public}-messages.js` and `instructions.js`. |

## What Ron chose

1. **Report a problem** — **one** entry point for the whole app, not a button per question. The same form also
   takes general feedback ("Idee", "Sonstiges").
2. **A periodic survey.**

A per-part rating was offered and not chosen. Storage is the **Hatoove database**: an owned table in the app's
own PostgreSQL, tied to the learner's account, exported with their data and deleted with their account. No new
data processor, no Gmail notice (that would be a later OPERATOR-MAIL-01 decision).

## 1. Data model — `server/migrations/0049-pilot-feedback.sql`

**`0049` carries the learner-facing tables only** (`pilot_feedback`, `pilot_feedback_screenshot`,
`survey_round`). The operator surface — the `__OPERATOR__` role, the `SECURITY DEFINER` read function and the
limited `UPDATE` grant — is **`0050-pilot-feedback-operator.sql`**, authored in FB-D (Stage 2), because it
changes deployment configuration.

Follow the house migration idiom: `__SCHEMA__`, `__LEARNER__`, `__DELETION__`, `__OPERATOR__` placeholders
resolved by the runner; `ENABLE` **and** `FORCE` row-level security; grants by role, never to `PUBLIC`.

### `pilot_feedback` — owned, RLS on the owner

| Column | Type / rule |
|---|---|
| `feedback_id` | `uuid` PK, server-generated |
| `owner_id` | `text NOT NULL` → `"user"(id)` |
| `kind` | `text NOT NULL`, `report` or `survey` |
| `category` | `report`: one of `content_error`, `audio`, `translation`, `bug`, `idea`, `other`. `survey`: NULL. |
| `body` | `text`, 1–2000 characters after trim. Required when `kind='report'`. NULL when `kind='survey'`. |
| `route` | closed list: `today`, `practice`, `drill`, `mock-run`, `review`, `listening`, `writing`, `library`, `vocab`, `mistakes`, `settings`, `other`. Client-supplied. |
| `exam_id`, `set_id`, `version`, `item_id` | nullable. Captured automatically from what is on screen when the form opens (open part/run, question in view; for a listening group, the group's first question). Never asked of the learner. |
| `guide_id`, `section_id` | nullable. Captured automatically on a reference-library page. |
| `run_id` | nullable. The open mock run or practice attempt. |
| `interface_language` | `de` / `en` / `uk` / `ar` / `tr` |
| `app_version` | short SHA of the deployed `.reviewed-commit`. **Set by the server, never by the client.** |
| `survey_round`, `answers` | `kind='survey'` only. `answers` jsonb, CHECKed against the round's question set: integers within range, plus at most one optional text ≤1000 characters. `answers IS NULL` means the learner skipped the round. |
| `status` | `new` / `triaged` / `fixed` / `wontfix`, default `new` |
| `operator_note` | `text` ≤1000 characters, nullable |
| `created_at`, `handled_at` | `timestamptz` |

Constraints and indexes:

- UNIQUE partial index on (`owner_id`, `survey_round`) where `kind='survey'` and `survey_round IS NOT NULL` —
  one survey row per learner per round.
- Index on (`status`, `created_at`).
- Index on (`exam_id`, `set_id`, `version`, `item_id`) so all reports about one item list together.

RLS (pattern of `0015-item-evidence.sql`):

- LEARNER policy `FOR SELECT` and `FOR INSERT` only: `owner_id = nullif(current_setting('hatoove.owner_id', true), '')`.
- The INSERT policy's `WITH CHECK` forces `status = 'new'` and leaves `operator_note` and `handled_at` NULL.
- The learner role gets **`SELECT` and `INSERT` only — no `UPDATE`, no `DELETE`.**
- A `__DELETION__` policy `FOR DELETE` (account erasure), as elsewhere.
- An operator read path via `SECURITY DEFINER` (see §4), not via learner grants.

### `pilot_feedback_screenshot` — owned, RLS on the owner

A separate table keeps listings light and allows at most one image per report.

| Column | Type / rule |
|---|---|
| `feedback_id` | `uuid` PK → `pilot_feedback(feedback_id)` ON DELETE CASCADE |
| `owner_id` | `text NOT NULL` → `"user"(id)`; must equal the report's owner (enforced by a trigger, not only by the client) |
| `mime_type` | `image/webp` or `image/png` |
| `bytes` | `bytea`, ≤1.5 MB |
| `width`, `height` | `int`; width ≤1600 px |
| `sha256` | `text`, computed by the server |
| `created_at` | `timestamptz` |

RLS and grants exactly as `pilot_feedback` (learner `SELECT`/`INSERT` only). At the pilot cap of 20 reports per
account per day, `bytea` is adequate: **no object storage, no new processor.**

### `survey_round` — content-class, read-only for the learner

| Column | Rule |
|---|---|
| `round_id` | `text` PK, e.g. `pilot-2026-10-a` |
| `opens_at`, `closes_at` | `timestamptz` |
| `questions` | jsonb: ordered question ids with type and range |
| `min_account_age_days` | `int`, default 7 |

Rounds run every 14 days from go-live to the end of the pilot window (14 Jan 2027), about 7 rounds. The
operator's seed command sets the dates; **the migration does not hard-code them.**

**Question set v1** (German first, then all 5 languages, formal *Sie* register):

| Id | Question | Answer |
|---|---|---|
| `ease` | Wie einfach ist Hatoove zu benutzen? | 1–5 |
| `useful` | Wie sehr hilft Ihnen Hatoove bei der Prüfungsvorbereitung? | 1–5 |
| `explanations` | Wie verständlich sind die Erklärungen? | 1–5 |
| `recommend` | Wie wahrscheinlich empfehlen Sie Hatoove weiter? | 0–10 |
| `next` | Was sollen wir als Nächstes verbessern? | optional text, ≤1000 characters |

### Lifecycle

- Register both tables in `tools/lib/catalogue.mjs` as owned tables (`survey_round` as content-class).
- Add both to `ACCOUNT_DELETION_STEPS` (`server/owned-postgres/adapter.mjs:1738`) — the **screenshot table
  before** `pilot_feedback`.
- Include the learner's own rows in the data export (`/api/v1/export`) as `feedback.json`, **without**
  `operator_note`; each image as `feedback/<feedback_id>.webp` (or `.png`).
- Pin the migration digest in `server/migrations/MANIFEST.json`.
- `tools/table-class-check.mjs` must pass with the new tables classified.

## 2. API — `server/owned-api.mjs` (+ `server/owned-postgres/`)

All routes require a session and accept a **closed** field set, as elsewhere in the owned API.

| Route | Behaviour |
|---|---|
| `POST /api/v1/feedback` | Body: `category`, `body`, `route`, plus optional captured context. **An unknown key gets 422; it is never silently dropped.** The server sets `owner_id`, `app_version`, `interface_language`, `status`, `created_at`. Returns `201 {feedback_id}`. |
| `PUT /api/v1/feedback/{feedback_id}/screenshot` | Raw image body (`Content-Type: image/webp` or `image/png`), ≤1.5 MB. Only the learner's own report; only within 10 minutes of creating it; only once (`409` after that). The server checks magic bytes against the declared type, reads dimensions from the header and refuses width >1600 px or any non-image, and stores the bytes unchanged. The report is saved **first**, so a failed upload never loses a report. Returns `204`. |
| `GET /api/v1/feedback` | The learner's own reports, newest first, with `status` and **without** `operator_note`. |
| `GET /api/v1/survey/current` | The open round the learner has neither answered nor skipped, if their account is old enough. Otherwise `204`. |
| `POST /api/v1/survey/{round_id}` | Either `{answers}` or `{skip: true}`. A second submission gets `409`. |

**Throttle:** 20 reports per account per 24 h, and 200 in total per hour. Above that, `429` with the existing
refusal copy.

**Validating captured context:** context is optional. When present it must point to something the learner can
actually see — a question they were served, an existing guide section, or their own run. **If the context is
invalid it is dropped and the report is still saved**, and the response includes `context: "dropped"`. A stale
page must never lose a report.

**Display:** `body` is **plain text only**; it is never rendered as HTML anywhere.

## 3. Client — `public/app/` + `public/assets/i18n/`

### One "Problem melden" entry for the whole app

No buttons on individual questions. Two openers, both opening the same small sheet over the current page:

- a small flag-icon button in the **top bar**, identical on every signed-in page;
- a **"Problem melden"** item under Werkzeuge in the sidebar.

Sheet contents:

- **Was ist passiert?** one of: Fehler in einer Aufgabe · Problem mit der Aufnahme · Übersetzung · Etwas
  funktioniert nicht · Idee · Sonstiges.
- **Beschreibung:** required, ≤2000 characters.
- **Context line:** what will be sent along, e.g. "Mitgesendet: Leseverstehen · Teil 1 · Aufgabe 3 (Fassung v1)",
  removable with ×.
- **Screenshot:** thumbnail with a ticked checkbox "Bildschirmfoto der Seite mitsenden"; clicking the thumbnail
  shows it full size; unticking sends no image. *(Stage 2 / FB-E; Stage 1 opens without this row.)*
- **"Senden"**, then "Danke! Wir sehen uns das an."

**Opening or sending the form must never navigate, reset the page or interrupt audio.** This is the listening
lesson from the 5 Oct incident: **no `listening.flush()` and no re-render of the run on this path.**

### Screenshot capture (FB-E)

- **When:** at the click on "Problem melden", **before** the sheet opens, so the image shows the page and not the form.
- **What:** the signed-in app area (`#main` plus the top bar) → canvas → scaled to ≤1280 px wide → WebP q0.7,
  falling back to PNG where WebP is unsupported; typically 60–200 KB.
- **How:** a DOM-to-image library (`html-to-image` or `modern-screenshot`, both MIT), **vendored** into
  `public/assets/vendor/` with its licence and a pinned SHA-256. **No CDN** (CSP). **No `getDisplayMedia`** — it
  prompts on every use and does not work on iOS Safari.
- **CSP:** the library renders through an SVG `foreignObject` into an `<img>`; if `img-src` lacks `data:` and
  `blob:`, add them for app pages only and record it in the security notes.
- **Masking:** elements marked `data-feedback-private` are drawn as grey blocks; mark the account e-mail and name
  in Konto, session lists, and any payment/order details; password fields are masked by type anyway. **Writing
  drafts are not masked** (they are often the subject of the report) — the learner sees them in the preview and
  may untick. Account e-mail in the top bar must be masked before Stage 2 ships.
- **Failure:** if capture fails or exceeds 3 s, the sheet opens with no thumbnail and the note
  "Kein Bildschirmfoto möglich"; the report still works.
- **Performance:** capture runs once per click, asynchronously, must not block input beyond a frame budget, and
  must never touch the listening controller or run state.

### "Meine Meldungen"

A page in Konto listing the learner's own reports with a status chip: neu · in Prüfung · behoben · nicht umgesetzt.

### Survey

- When a round is open, a dismissible card on **Heute**: "2 Minuten: Wie läuft der Pilot für Sie?"
- Five questions on one page; rating rows are radio groups with labelled ends, never colour alone.
- **"Später"** hides the card for the current session.
- **"Nicht teilnehmen"** records a skip and the learner is not asked again in that round.

### Copy

Every new string goes into all 5 dictionaries. `tools/i18n-register-check.mjs` must stay green: formal *Sie*
address, no informal 2nd-person forms, inline defaults in agreement with the catalogue, key parity across
de/en/uk/ar/tr. The uk/ar/tr versions are flagged for native review. Arabic is RTL with the existing
exam-language/LTR islands.

## 4. Operator tool — `server/feedback.mjs`

Run as `docker compose run --rm app node server/feedback.mjs …`. It connects through a dedicated
`__OPERATOR__` role: reads across owners via a `SECURITY DEFINER` read function, may update only `status`,
`operator_note` and `handled_at`, and **must not reuse the migration role.**

**The role does not exist yet** — `server/owned-postgres/` provisions `migration`, `auth`, `learner`, `worker`,
`deletion`, `payments`, `provisioner`, and `provision.mjs`'s `renderSql` only substitutes roles present in
`config.roles`. FB-D therefore adds `operator` to `ROLES` in `server/owned-postgres/provision.mjs`, to the role
map, pool and substitution loop in `server/owned-postgres/bootstrap.mjs` (the two placeholder sites **must not
drift** — `bootstrap.mjs:152` records the time they did), and takes its password from
`OWNAPI_PG_OPERATOR_PASSWORD`. Migration `0050` then grants it `EXECUTE` on the read function and on a bounded
`UPDATE` function only.

| Command | Effect |
|---|---|
| `list [--status new] [--category] [--since 7d]` | Compact table in the terminal |
| `show <feedback_id> [--save-screenshot out.webp]` | One report in full; when an item was captured, also its German prompt and answer key; optionally saves the screenshot |
| `export --csv [--since] [--screenshots <dir>] > feedback.csv` | UTF-8 **with BOM** so it opens in Excel; survey answers spread into their own columns; with `--screenshots`, images written to `<dir>/<feedback_id>.webp` and a `screenshot_file` column added |
| `set-status <feedback_id> <triaged\|fixed\|wontfix> [--note "…"]` | Updates status and sets `handled_at` |
| `summary [--round <id>]` | Counts by category and route, the 10 most-reported items, survey averages incl. the recommend score (% 9–10 minus % 0–6) and the number of responses |
| `purge --older-than <days>` | Retention clean-up per §5 |

Also: a **survey-round seed** command that writes the round dates and the question set (the migration does not
hard-code them).

**Later, only if Ron asks:** a read-only feedback page inside the app, or the Gmail notice via OPERATOR-MAIL-01.

## 5. Privacy

- Free text may contain personal data; it belongs to the learner, appears in their export, and is deleted with
  their account.
- Screenshots can show the learner's own answers and drafts: account details are masked, the learner sees the
  image before sending and can untick it, and images are deleted with the account under the same retention.
- **Retention (default, Ron to confirm):** reports deleted 12 months after the pilot window ends.
- Privacy notice line: "Meldungen, Bildschirmfotos und Umfrageantworten, die Sie senden, werden mit Ihrem Konto
  gespeichert, um Hatoove zu verbessern."
- No feedback text is sent to any AI provider or other third party.

## 6. Acceptance — each item independently reviewed

1. **Migration:** applies on a disposable PostgreSQL (port verified free first); checksum pinned in
   `MANIFEST.json`; `table-class-check` passes; learners cannot see each other's rows (RLS isolation legs); a
   learner cannot UPDATE or DELETE their rows.
2. **API:** closed field set; `body` required for reports; captured context validated and invalid context
   dropped while the report is still saved; `429` over the throttle; `409` on a second survey submission; a skip
   is recorded; an account too new for the survey gets `204`.
3. **Account deletion** removes the learner's rows; the data export includes them, without `operator_note`.
4. **Client:** the top-bar button appears on every signed-in view and on no public page; opening and sending the
   form during listening playback does not pause the audio (browser leg); the context line names the question in
   view and × removes it; the sheet is keyboard-operable and focus returns to the button; rendered checks at 1366
   and 390 px, both themes, all 5 languages; Arabic RTL displays correctly.
5. **Screenshot (FB-E):** the capture shows the page, not the sheet; works in Chrome/Firefox/Safari desktop and
   390 px mobile Chrome/Safari; Arabic RTL and embedded fonts render; `data-feedback-private` appears masked;
   unticking sends no upload; a capture failure still lets the report be sent; listening audio keeps playing
   during capture.
6. **Upload:** wrong type, declared-type/magic-byte mismatch, >1.5 MB, width >1600 px, another owner's report,
   more than 10 minutes after the report, and a second upload are each refused; account deletion removes the
   images; the export contains them.
7. **Operator tool:** the CSV opens in Excel with umlauts and Arabic intact; `summary` matches a hand count on a
   fixture.

## 7. Slices and allowed paths

| Slice | Scope | Allowed paths (advisory, one writer per file) |
|---|---|---|
| **FB-A** | Migration `0049`, catalogue entry, `ACCOUNT_DELETION_STEPS`, export, RLS/table-class legs, MANIFEST pin | `server/migrations/0049-pilot-feedback.sql`, `server/migrations/MANIFEST.json`, `tools/lib/catalogue.mjs`, `server/owned-postgres/adapter.mjs`, `server/owned-api.mjs` (export only), `tools/deletion-check.mjs`, `tools/table-class-check.mjs`, new `tools/pilot-feedback-migration-check.mjs` |
| **FB-B** | API routes and throttle | `server/owned-api.mjs`, `server/owned-postgres/feedback.mjs` (new), `server/owned-postgres/throttle.mjs`, new `tools/pilot-feedback-api-check.mjs`, `server/owned-postgres/fixture.mjs` |
| **FB-C** | The single report sheet (top bar + sidebar), "Meine Meldungen", the survey card, copy in 5 languages | `public/app/*.js`, `public/app/app.css`, `public/app/index.html`, `public/assets/i18n/*.js`, new `tools/pilot-feedback-client-check.mjs` |
| **FB-D** | Operator CLI, `__OPERATOR__` role + migration `0050`, survey-round seeding, CSV export | `server/migrations/0050-pilot-feedback-operator.sql` (new), `server/feedback.mjs` (new), `server/owned-postgres/{provision,bootstrap,config}.mjs`, `tools/pilot-feedback-operator-check.mjs` (new), `docs/openapi.yaml`, docs |
| **FB-E** | Screenshot **upload route** + vendored capture library, masking, thumbnail, operator `--save-screenshot` / `--screenshots`. **No migration** — the table is already in `0049`. | `public/assets/vendor/**` (new), `public/app/*`, `server/owned-api.mjs`, `server/owned-postgres/feedback.mjs`, `server/feedback.mjs`, `public/app/index.html` (CSP), security notes |

**Order.** FB-A, then FB-B. FB-C and FB-D then run in parallel against the frozen §2 API. FB-E follows FB-C.
Stage 1 deploys A+B+C+D; Stage 2 deploys E (A2).

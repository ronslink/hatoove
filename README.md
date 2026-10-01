# Hatoove exam preparation

**Local workspace:** use `D:\Hatoove` for code, `D:\Hatoove\design` for the original design reference and `D:\Hatoove\handoff\ron-agent` for coordination. [Workspace location and recovery](docs/WORKSPACE_LOCATION.md) supersedes historical checkout paths below.


The canonical development repository is [ronslink/hatoove](https://github.com/ronslink/hatoove). Start with the [master plan](MASTER-PLAN.md) for the consolidated progress view, then the [revised implementation plan](IMPLEMENTATION_PLAN.md), [agent instructions](AGENTS.md), [work cadence](docs/AGENT_WORKFLOW.md), [task board](work/BOARD.md) and [pilot product plan](PILOT_BUILD_PLAN.md).

The pilot covers reading, language elements, listening and writing. Preserve the existing `public/` learner interface as the logged-in visual foundation and adapt it for mobile. `hatoove-site/dist/` is the maintained orange marketing/practice preview, not generated build output. Hosting and production changes are outside this repository preparation.

Safe checks in a clean source checkout require Node 22 or newer and no credentials:

```text
node tools/repository-check.mjs
node tools/check.js
node tools/writing-check.js
node tools/feedback-check.js
```

The offline baseline is 124 checks. Use independent clones for local Codex, Hetzner OpenClaw and Docker Hermes. Do not copy `.env`, progress records or agent profiles between them. Read [repository baseline notes](docs/REPOSITORY_BASELINE.md) before using legacy scripts.

## Historical local app instructions

The remaining instructions document the original installed application. They are retained for reference; their five-part scope, scoring claims and machine-specific paths do not define the Hatoove pilot.

> **Certa Academy interface update (23 September 2026):** see [design and installation notes](DESIGN_NOTES.md) for the new dashboard, responsive navigation and verification. The [exam/product review](exam-product-review.md) identifies existing writing, speaking and scoring mismatches against the official telc model exam. The older format claims below describe the current implementation and must not be treated as an audited specification until those corrections are complete.

A local web app that trains all five subtests of the telc Deutsch B1 exam
(*Zertifikat Deutsch*), generates fresh questions on demand, and continuously
re-weights practice toward whatever is currently costing you points.

Built for one specific goal: **pass the exam next weekend**.

---

## Quick start

Start the server as an ordinary process and open the app:

```bash
node server.js
```

Then open **http://127.0.0.1:4321**.

Keep it running while you study — closing it (or pressing Ctrl+C) stops the server. The server is an ordinary
process: it does not start itself, and it stops when you reboot.

There is nothing to install — the app has **zero dependencies** and needs only Node 20+.

### Running as a hosted service

**This project is being converted from a local single-user install to a server serving multiple users.** The
hosted shape, the deployment decisions and what is still missing are recorded in
[`work/implementation/SAAS-CONVERSION.md`](work/implementation/SAAS-CONVERSION.md),
[`MULTI-USER-TRANSITION.md`](work/implementation/MULTI-USER-TRANSITION.md),
[`SERVER-READINESS.md`](work/implementation/SERVER-READINESS.md) and
[`HOSTED-BLOCKERS.md`](work/implementation/HOSTED-BLOCKERS.md). Read those before deploying anything: **the
application is not yet hosted-ready** and the records say precisely why.

**Removed with the local-install shape, deliberately:** the `start.cmd` launcher, the portable/USB build
(`portable/**`, `tools/build-portable.ps1`, `tools/verify-portable.js`), the synchronisation tool
(`tools/sync-home.js`) and the file-based progress recovery script (`tools/recover-progress.js`). A hosted service
has one authoritative copy on the server, so there is nothing to sync, copy or recover from a local file. The
history is in [`work/implementation/DROPPED-FOR-SAAS.md`](work/implementation/DROPPED-FOR-SAAS.md).

Restart the home app afterward so its browser cache reloads the merged record.

### The Desktop icon

`b1prep.ico` is committed, so the shortcut works as-is. To regenerate it (or change the
artwork), edit the draw routine in `tools/make-icon.js` and run:

```bash
npm run icon
```

It renders the tile in a real browser so the text is properly hinted, then packs
16/24/32/48/64/128/256px into a multi-resolution `.ico`. If Windows shows a stale icon
after regenerating, refresh the Desktop with F5.

### Configure the AI provider (operator)

The AI provider is **server configuration, not a learner setting**. The Settings page offers
no key field, and no route tells the browser whether a key exists - so a learner cannot set,
change or read it. Set it once in the server environment (or in the server's `.env`):

```text
DEEPSEEK_API_KEY=...
# optional:
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Get a key at <https://platform.deepseek.com/api_keys>. The key is read at startup and never
sent to the browser.

**Without a key the app still works.** See [Offline mode](#offline-mode).

---

## What it trains

The structure follows the official telc B1 test format (telc gGmbH, *telc Deutsch B1
Übungstest 1* — "Testformat" and "Punkte und Gewichtung"):

| Subtest | Parts | Items | Points | Time |
|---|---|---|---|---|
| **Leseverstehen** | 3 | 1–20 | 75 | shares 90 min |
| **Sprachbausteine** | 2 | 21–40 | 30 | shares 90 min |
| **Hörverstehen** | 3 | 41–60 | 75 | ~30 min |
| **Schreiben** | 1 | one letter/e-mail | 45 | 30 min |
| **Sprechen** | 3 | Präsentation, Diskussion, Planung | 75 | ~15 min (+20 min prep) |

Written: **225 points, pass at 135 (60%)**. Oral: **75 points, pass at 45 (60%)**.
Both sections must be passed separately.

Task shapes are reproduced faithfully, including the details people lose marks on:

- **LV Teil 1** — 10 headlines (a–j) for 5 texts, so 5 headlines are always distractors.
- **LV Teil 3** — 10 situations against 12 adverts, and **"x" is a real answer** when
  no advert fits. The app always includes those cases.
- **Hörverstehen** — every item is **Richtig/Falsch**, never multiple choice.
  Teil 1 plays **once**, Teile 2 and 3 play **twice** — and the player enforces it.
- **SB Teil 2** — a 15-word bank for 10 gaps, so 5 words are always left over.
- **Schreiben** — an informal or semi-formal letter with exactly 4 Leitpunkte. New tasks
  alternate between informal (`du`) and semi-formal (`Sie`), starting with informal.
  The rotation is saved with your progress and applies to AI and offline tasks.
- **Sprechen** — the three oral task types, with Redemittel and a preparation timer.

---

## The exam core (`Prüfungskern`)

Word lists are the wrong thing to study for this exam. In Sprachbausteine Teil 2 of the
official Übungstest 1 the 15-word bank is:

```
BESONDERS · DA · DAFÜR · DAMALS · DAMIT · DANKBAR · DESHALB · FÜR ·
GERNE · KÖNNTEN · MIT · MÜSSTEN · SCHLIESSLICH · WANN · WENN
```

**Not one rare noun.** The marks sit in *function words* — connectors, prepositions,
Konjunktiv II and fixed phrases — because those are what hold a sentence together, and
that is what the exam can test reliably.

So the trainer leads with a curated **255-item exam core** (`data/core-grammar.json` +
`data/core-phrases.json`), drilled as its own spaced-repetition deck:

| Block | Items | Why |
|---|---|---|
| Konnektoren & Funktionswörter | 45 | Each carries its **word-order rule** (`deshalb` = verb in position 2, `weil` = verb to the end) — the single most tested thing |
| Konjunktiv II & Höflichkeit | 17 | The polite letter and speaking forms |
| Verben mit Präposition | 37 | With the case spelled out (`sich interessieren für + Akkusativ`) |
| Nomen-Verb-Verbindungen | 26 | `eine Entscheidung treffen`, `Bescheid geben` |
| Redemittel: Schreiben | 28 | Formulaic letter phrases — memorising these converts directly into marks |
| Redemittel: Sprechen | 30 | Presentation, discussion and planning formulae |
| Themenwortschatz | 72 | Nouns with article **and plural**, verbs with Perfekt, across the six real exam themes |

It is drilled *before* the general 300-word deck, and each block can be practised on its
own — so you can spend twenty minutes on nothing but `Verben mit Präposition`.

Generated paper parts, writing tasks and speaking tasks also draw from the **actual
themes** the exam reuses (Haushalt, Freizeit und Vereine, Reisen, Gesundheit, Bildung,
Essen und Trinken; oral: Gruppenreisen, Fernsehen, Handy, Haustiere, Online-Einkaufen,
Auto in der Stadt, Stadt oder Land) rather than a generic B1 spread.

---

## The Lernplan tracks itself

The day-by-day plan is not a static list. **Each task ticks itself off from the work you
actually did**, so finishing an exercise shows up without you ticking anything:

| Task | Counted as done when you record |
|---|---|
| `Prüfungsteil üben: …` | attempts on that part from the Prüfungsteile view |
| `Adaptive Übungen` | any drill item, AI item, or vocabulary card |
| `Schreiben: …` | a graded writing piece |
| `Sprechen: …` | a speaking submission |
| `Hören: …` | a full listening part |
| `Kompletter Mocktest` | a finished mock exam |

Today's card shows **`2 von 4 erledigt`** with a progress bar, and the Übersicht preview
shows the same. A tick earned from real work is locked (it is a fact, not an opinion);
tasks that leave no trace — a self-graded review session, for instance — get a clickable
`○` you can tick by hand, and those ticks are saved and merged like everything else.

Every task opened from the plan carries a **← Lernplan** link back, so you are never
stranded in a sub-view.

---

## How it adapts to your weak points

Every answer updates two kinds of nodes on a 0–100 ability scale, using an
Elo update with a shrinking step size:

- `skill:LV3` — how you are doing on one exam part
- `tag:dativ_praeposition` — how you are doing on one specific skill

Around 40 tags cover the grammar and vocabulary that actually recur in telc B1
(case after prepositions, relative pronouns, the Perfekt auxiliary, adjective
endings, connectors, pronouns, register…), plus reading/listening strategies and
writing/speaking criteria.

Three things then decide **what you see next**:

1. **Target difficulty** — the engine asks for an item at `ability + 8`, which lands
   near a 70% success rate: hard enough to teach you something, easy enough to keep you going.
2. **Priority** — size of the gap × how little evidence we have × how stale it is ×
   how many exam points the node drives. Writing and speaking carry the most points per
   task, so they float up.
3. **Variety** — consecutive drill items never repeat a tag, and the scheduler reserves
   weight for topics you have not touched yet.

### How ability is estimated

The live update is an Elo step: cheap, and it gives recency. But it is **path-dependent**.
A lucky start inflates the estimate, and the update is asymmetric enough that it never
fully settles back. Measured against the recorded attempts it had drifted badly — it put
Hörverstehen Teil 1 at 84 when 70% correct implies about 65, and Sprachbausteine Teil 2 at
43 when 45% correct implies about 57. Those errors ran in both directions, so the forecast
was not merely cautious, it was wrong.

The number driving **the forecast and the prioritisation** is therefore the
**maximum-likelihood estimate over the attempts actually recorded** — the ability that
best explains what you really did — shrunk toward 50 for small samples so two lucky
answers do not read as mastery. The per-part forecast now tracks the observed hit rate
closely: an observed 38% in Schreiben forecasts 37%, where the Elo claimed 67%.

Results feed three outputs:

- **Prognose** — predicted written/oral points and pass/fail, with a confidence figure
  that only rises as you produce evidence.
- **Fehlerheft** — every mistake, with the explanation, resurfacing after 1, 3, 7, 16 and 35 days.
- **Lernplan** — a dated, day-by-day plan sized to the days you actually have left. It cycles
  Leseverstehen → Sprachbausteine → Hörverstehen so no subtest is starved, puts the full timed
  rehearsal on the penultimate day, and leaves the final day to taper rather than cram.

---

## The views

| View | What it does |
|---|---|
| **Übersicht** | Forecast, per-part breakdown, current weaknesses, 14-day activity, plan preview |
| **Adaptive Übungen** | The core loop: one question at a time, difficulty-matched, instant feedback |
| **Wortschatz** | The 255-item exam core (drillable block by block) plus a 300-word general deck, both spaced-repetition |
| **Fehlerheft** | Your mistakes, with explanations and a review queue |
| **Prüfungsteile** | Any full exam part in the original format, scored in telc points |
| **Hören** | Hörverstehen with browser text-to-speech and the real play-count rules |
| **Schreiben** | Generate a task, write it, get a corrected version and an estimated /45 |
| **Sprechen** | Oral task cards, prep timer, dictation, and feedback on structure and vocabulary |
| **Mocktest** | Full timed written exam: 150 minutes, 225 points, real pass marks |
| **Lernplan** | The dated day-by-day plan. Tasks tick themselves off as you do them, and every task opened from here has a **← Lernplan** link back |
| **Einstellungen** | Exam date, TTS voice and speed, AI drills toggle, export/import, reset |

---

## Nachschlagen — the reference library

Everything read-only lives behind **one** sidebar entry. It opens an index of six areas,
each reachable from there or from the practice view that needs it, and each with a
**← Nachschlagen** link back. Nothing in them is tested or scored, and none of them needs
an API key.

| Area | What is in it |
|---|---|
| **Redemittel Sprechen** | How to approach each oral task step by step and timed, **108 phrases** grouped by function with a whole example sentence each, **6 full model answers**, and the typical mistakes per task |
| **Briefe schreiben** | The six decisions that cost or earn marks (register, the four Leitpunkte, structure, salutation, length, what markers look for), **44 building-block phrases**, **4 complete model letters**, a submission checklist. Good-vs-bad contrasts shown side by side |
| **Fälle & Artikel** | The **der/die/das system across all four cases**: definite and indefinite articles, possessive and personal pronouns, adjective endings, n-Deklination, question words — **8 tables**, plus which prepositions and verbs force which case. Cells that differ from the nominative are highlighted |
| **Nomen & Genus** | The 6 rules that predict gender from the ending or the meaning, **40 exceptions** that break them (with the gender you would wrongly guess), **14 words that change meaning with the article** (`der See` / `die See`), and a **240-noun lexicon** filterable by gender and searchable, each with article, plural, meaning and the rule behind it. Nouns with no plural (`das Glück`, `der Stolz`) carry the marker `kein Plural` rather than an invented form — the deck is also the gender drill, so every noun needs `pos: "noun"` or the article question silently degrades into a meaning question |
| **Grammatik** | **14 topics** — reflexive verbs (`sich` with the case table), `um … zu` vs `damit`, `Infinitiv mit zu`, subordinate-clause word order, Wechselpräpositionen, prepositions and case, relative clauses, Perfekt/Präteritum, Konjunktiv II, adjective endings, modal verbs, comparison, separable verbs, passive — each with a plain-language rule, the pattern, look-up tables and **84 worked examples** |
| **Satzbau verstehen** | Type a sentence and see how it is built: which word is the finite verb, where it sits, and which rule explains it. See below |

Everything German in these pages has a speaker button, and the noun lexicon doubles as a
**gender drill** (article, plural and meaning, 60 % weighted to the article).

### Everything is bilingual

The app is German-first — the exam is in German — but every piece of *explanation* also
carries its English counterpart, because a rule you cannot fully follow is a rule you cannot
use. English appears directly under the German, in a dimmed style, so it never competes with
the German you are meant to absorb:

| Where | What is translated |
|---|---|
| Card explanations | The headword's meaning, the plural, and the example sentence |
| Noun lexicon | Every example sentence (240) and every rule label (31) |
| Genus | The intro, all 6 rule notes, all **40** exception reasons, all **14** double-gender reasons, the watch-outs |
| Fälle & Artikel | Table titles, purposes, notes, column headers, and the case names in the rows |
| Grammatik | Topic titles, why, the full rule text, the pattern, table headers, and every trap |
| Sprechen / Schreiben | Part summaries, every timed step, every strategy point, phrase-group headings and hints, checklists, watch-outs, model-letter briefs |
| Satzbau | The rule name and explanation, and every diagnostic message and hint |

Deliberately **not** translated: the exam papers themselves (`data/seed.json`), the model
letters and spoken model answers, and the drill prompts. Those are the actual test material —
translating them would defeat the point.

Two conventions worth knowing if you edit the data:

- The German field keeps its name and the translation takes an `En` suffix: `rule` / `ruleEn`,
  `why` / `whyEn`, `example` / `exampleEn`. Array fields pair by index (`checklist` /
  `checklistEn`), so the two must stay the same length.
- `tools/check.js` enforces this. Four checks fail loudly when a field is added without its
  translation, so the app cannot silently drift back to German-only.

### Satzbau verstehen

A live clause analyser. It works instantly with no API key and no network, because the
questions it answers are mechanical:

- **Where is the finite verb, and why there?** A main clause puts it in position 2; a
  subordinate clause pushes it to the end; after a subordinate clause the main clause
  begins with it.
- **Is there a sentence bracket?** Perfekt and modal verbs have two halves, and it checks
  both are present.
- **Is a noun after an article capitalised?**

For `Am Montag ich fahre nach Berlin.` it says:

> **Fehler:** Vor dem Verb stehen zwei Satzteile („Am Montag ich"). Im Hauptsatz darf nur
> EIN Satzteil im Vorfeld stehen.
> → Richtig: „Am Montag fahre ich …"

and for each clause it shows the Vorfeld, the finite verb, the Mittelfeld and the closing
bracket, with the rule named and explained. It is deliberately conservative — it only
reports what it recognises confidently, because a wrong correction teaches the wrong thing.
A **KI-Erklärung** button adds a full breakdown (role and case of every part) when the AI
provider is configured.

---

## Offline mode

With no API key, everything except AI text generation still works:

- **17 grammar/vocabulary drill generators** with hand-written B1 item pools — effectively
  unlimited practice, randomised option order, difficulty-ranked selection
- The 300-word vocabulary deck with spaced repetition
- Full exam parts from a bundled bank of 24 authentic sets (3 per part)
- The complete mock exam
- A deterministic writing check (length, register consistency, greeting/closing,
  connector variety, Leitpunkt coverage)
- Speaking task cards, Redemittel, model answers and timers

When a key **is** configured, AI questions are current-supported: generated paper parts,
fresh drill items, full writing correction and speaking feedback. If a model call fails
or returns something malformed, the app silently falls back to the offline content and
tells you why — a broken API never blocks a study session.

---

## Listening (text-to-speech) and speaking

Both degrade gracefully, but the listening one has a gotcha worth knowing.

- **Listening** uses the browser's Web Speech API. **Chrome ships its own German voice,
  "Google Deutsch" (de-DE), as a network voice** — you do not have to install anything.
  Two consequences:
  - It needs an **internet connection**. Offline, no German voice is available.
  - Checking Windows alone is misleading. Windows ships no German SAPI/OneCore voice on
    this machine, yet listening works fine, because Chrome supplies its own. If the app
    ever cannot find a German voice it says so and points you at the transcript rather
    than silently reading German with an English accent — which would train the wrong
    pronunciation, worse than nothing.
  - Verify any time with `node tools/tts-check.js` (runs a real browser off-screen and
    reports the voices, measures synthesis, and confirms the player starts audio).
- **Speaking** can use live dictation (Chrome and Edge). Anywhere else, you speak aloud
  and type what you said — the feedback pipeline is identical. Pronunciation is
  deliberately reported as *not judgeable* from a transcript rather than faked.
  - **The dictation resumes itself.** Chrome's `SpeechRecognition` stops on its own after
    a few seconds without speech, and again at a hard limit of about a minute, *even with
    `continuous = true`*. The first version treated that as you having finished, so
    recording appeared to start and then simply stop part-way through an answer. The app
    now resumes listening until you press stop, and keeps the transcript across every
    internal restart, so nothing said earlier is lost. The status line shows how many
    words have been recognised so you can see it is still live.
  - It needs an internet connection and microphone permission; a denied or missing
    microphone stops cleanly with an explanation rather than retrying forever.

---

## Tests

```bash
node tools/check.js      # 98 logic + content checks, no browser needed
node tools/e2e.js        # 79 checks in headless Chrome against the offline path
node tools/tts-check.js  # real-browser speech diagnostic (voices, timing, playback)
node tools/ai-live.js    # validates the REAL DeepSeek path (needs a key; spends credit)
```

For the AI path, a mock DeepSeek server is included so no key or credit is needed:

```bash
node tools/mock-deepseek.js 4399                       # terminal 1
DEEPSEEK_API_KEY=test DEEPSEEK_BASE_URL=http://127.0.0.1:4399 node server.js   # terminal 2
node tools/e2e-ai.js                                   # terminal 3  → 29 checks
```

`tools/e2e-ai.js` proves the *plumbing* against the mock. `tools/ai-live.js` proves the
*real model*: for each subtest it reports whether content actually came from DeepSeek or
silently fell back to the built-in pools, the validation error that caused any fallback,
and how long each call took. Run it after saving a key.

`tools/check.js` verifies the exam blueprint arithmetic, the ability model's behaviour
(success raises ability, hard wins count more, values stay bounded), that the drill
actually favours the weakest tag, telc scoring and grade bands, and the structural
integrity of both content packs.

The browser tests drive real Chrome over the DevTools Protocol and assert there are
**no console errors** along the way.

---

## Files

```
server.js                 zero-dependency server: static files + DeepSeek proxy + key storage
b1prep.ico                app icon used by the Desktop shortcut
.env.example              config template
progress.json             YOUR PROGRESS (written automatically; back this up)
public/
  index.html styles.css
  js/blueprint.js         the exam structure and the weakness taxonomy
  js/store.js             state, persistence, ability model, spaced repetition
  js/progress-merge.js    monotonic merge shared by the server and the browser
  js/engine.js            targeting, prioritising, scoring, forecast, study plan
  js/generators.js        17 offline grammar/vocab item generators
  js/ai.js                DeepSeek prompts, JSON contracts, validation, fallbacks
  js/speech.js            text-to-speech and speech recognition
  js/shell.js             DOM helpers, toasts, routing registry
  js/ui.js                dashboard, drill, vocabulary, notebook, plan, settings
  js/exam.js              paper parts, listening, writing, speaking, mock exam
  js/guides.js            the read-only reference areas
  js/satzbau.js           the clause analyser (pure logic, unit-tested)
  js/app.js               bootstrap and routing
data/
  seed.json               24 offline exam sets (3 per part)
  vocab.json              300 B1 words with examples
  core-grammar.json       exam core: function words, Konjunktiv II, verb+preposition, collocations
  core-phrases.json       exam core: Redemittel for writing and speaking, thematic vocabulary
  speaking-guide.json     reference: oral strategy, 108 phrases, model answers
  writing-guide.json      reference: letter strategy, 44 phrases, 4 model letters
  grammar-guide.json      reference: 14 grammar topics, 84 worked examples
  cases-guide.json        reference: der/die/das across the four cases, 8 tables
  gender-rules.json       reference: gender rules, 40 exceptions, 14 double-gender words
  noun-lexicon.json       reference/drill: 240 nouns with article, plural, meaning, rule
tools/
  check.js                logic + content checks (no browser)
  e2e.js                  headless-Chrome test of the offline path
  e2e-ai.js               headless-Chrome test of the AI path (against the mock)
  ai-live.js              validates the REAL DeepSeek path (needs a key; spends credit)
  tts-check.js            real-browser speech diagnostic (voices, timing, playback)
  cdp.js                  shared DevTools-protocol harness
  make-icon.js            regenerates b1prep.ico by rendering it in a real browser
  mock-deepseek.js        mock DeepSeek API so the AI path is testable without a key
```

## Where your progress is stored

**In `progress.json`, next to the app, written by the server.** That is the authoritative
copy. The browser's `localStorage` is only a fast local cache — it disappears with cleared
site data, a different browser, a different profile, or a changed port, none of which should
cost you a week of study.

How it behaves:

- Every answer is saved automatically (debounced ~1s), and again when the tab is hidden or closed.
- **Every write is merged, never overwritten.** A plain last-write-wins save is unsafe here:
  saves are debounced and can come from more than one tab, so a tab holding a slightly older
  snapshot could flush *after* one that had already saved newer answers and silently erase them.
  That happened for real — a later save once carried 68 fewer attempts than the one before it.
  The merge is **monotonic**: the result never contains less evidence than either side, so no
  write can lose work no matter which tab or order it arrives in.
- Ability estimates keep whichever is backed by more evidence; the attempt log is a multiset
  union (five questions logged in the same millisecond are five attempts, not one); the notebook
  and spaced-repetition state are unions; daily totals are per-day maxima.
- On startup the app compares timestamps and the newer copy seeds the merge, so it always opens
  on your current state.
- Writes are atomic (write to a temp file, then rename) and one generation back is kept as
  `progress.json.bak`. A corrupt or interrupted write cannot destroy your history.
- If the server is unreachable the app keeps working on the local cache and says so in
  *Einstellungen*; saving resumes when the connection returns.
- Upgrading from an earlier version: your existing browser-only progress has no server copy,
  so it is **uploaded** on first load rather than discarded.

*Einstellungen* shows the sync state and has a **Jetzt sichern** button. You can still
export/import a JSON file for an off-machine backup.

### Recovering lost progress

**The file-based recovery tool has been removed** with the rest of the local-install tooling
(`tools/recover-progress.js`; see [`DROPPED-FOR-SAAS.md`](work/implementation/DROPPED-FOR-SAAS.md)). It existed to
fold a local `progress.json` backup back into a local record, which is a problem the hosted shape does not have:
recovery becomes the operator's database backup and restore, and the retention policy for that is recorded in
[`PROVIDER-CONFIG-01.md`](work/implementation/PROVIDER-CONFIG-01.md) as a decision still owed by the product owner.

On a local install the merge-on-save behaviour still protects a partial write from erasing a record — that is
`public/js/progress-merge.js`, and it is deliberately still present.


---

## Honest caveats

- **The forecast is an estimate, not a result.** It sharpens as you practise; the
  confidence figure tells you how much to trust it.
- **Sprechen sub-weights are an equal-thirds estimate.** The 75-point total and the
  45-point pass mark are the official values; telc does not publish a fixed per-part split.
- **AI-generated content should be sanity-checked.** It is constrained by strict JSON
  contracts and validated before display, but a language model can still produce the odd
  oddity. If something looks wrong, regenerate it.
- **A mock exam cannot replace a real partner.** telc Sprechen is a pair examination;
  the app trains the task types and language, not the interaction with a live partner.
- The app binds to `127.0.0.1` only, because it stores an API key.

# SEC-03 — disclose that learner text is sent to the AI provider (fixes F-3)

Execution: `sec-03-claude-20260930-a` · Worker: Claude for Windows · Coordinator: `COORD-TAKEOVER-20260930`
Branch: `codex/sec-03-disclosure` · Base: `de4ecb6e68f089218ef92c3879e392063356efa2`

> **Provisional copy.** This is learner-facing German text and needs native-speaker review (`C-06`) before it
> counts as approved. It closes no privacy, legal or security gate; human `P-03` review remains required.

## Change

One paragraph added to the Settings "DeepSeek-Schlüssel" card in `public/js/ui.js`, directly after the existing key
notice, using the existing `<p class="muted small">` style. No CSS change was needed. No layout change.

### Before

```html
<h3>DeepSeek-Schlüssel</h3>
<p class="muted small">Der Schlüssel wird nur lokal in <span class="mono">.env</span> auf diesem Rechner gespeichert und nie an den Browser zurückgegeben. Ohne Schlüssel läuft die App im Offline-Modus weiter.</p>
<div class="btn-row mb">
```

### After

```html
<h3>DeepSeek-Schlüssel</h3>
<p class="muted small">Der Schlüssel wird nur lokal in <span class="mono">.env</span> auf diesem Rechner gespeichert und nie an den Browser zurückgegeben. Ohne Schlüssel läuft die App im Offline-Modus weiter.</p>
<p class="muted small">Mit Schlüssel schickt der lokale Server bei KI-Funktionen deine Texte an den KI-Anbieter (standardmäßig DeepSeek): deine Briefe und E-Mails zur Bewertung, deine mündlichen Antworten als Transkript, Sätze aus „Satzbau verstehen“ und – wenn du „Genauer erklären“ wählst – deine Antwort im Drill. Ohne Schlüssel wird davon nichts gesendet.</p>
<div class="btn-row mb">
```

Register: informal *du*, matching the rest of the Settings page ("Übe zuerst langsamer", "So bekommst du eine
deutsche Stimme"). Quotation marks „…“ match existing usage in the same view.

## Facts verified in code

| Claim in the copy | Where verified |
| --- | --- |
| Requests go through the local server, which forwards them upstream | `public/js/ai.js` `callAI` → `POST /api/ai`; `server.js` `/api/ai` handler → `callDeepSeek` → `fetch(`${s.baseUrl}/chat/completions`)` |
| Provider is DeepSeek **by default** | `server.js` `settings()`: `baseUrl` = `DEEPSEEK_BASE_URL` or `https://api.deepseek.com`. The base URL is configurable (`POST /api/config` accepts `baseUrl`, constrained by SEC-01), hence "standardmäßig". |
| Letters/e-mails are sent for grading | `ai.js` `gradeWriting` embeds the learner text (`text.slice(0, 4000)`); called from `exam.js` (writing practice and mock exam) |
| Spoken answers are sent as a transcript | `ai.js` `gradeSpeaking` embeds `transcript.slice(0, 4000)`; `exam.js` passes either the speech-recognition result or the typed `#spoken-text` |
| Sentences from "Satzbau verstehen" are sent | `ai.js` `explainSentence` embeds `sentence.slice(0, 400)`; called from `guides.js` (Satzbau section) |
| Drill answers are sent only via "Genauer erklären" | `ai.js` `coachDrillAnswer` embeds `yourAnswer`; the only caller is the `data-explain` button in `ui.js`, shown only for wrong answers and gated by `ai.isConfigured()` |
| Without a key nothing is sent | `server.js` `callDeepSeek` throws `NO_KEY` (400) before any upstream `fetch` when `s.apiKey` is empty |

### Correction / refinement to the audit's description

The audit (F-3) lists letters/essays, spoken-answer transcripts and drill answers. The code confirms all three, with
two refinements:

1. **Drill answers are not sent automatically.** Only a wrong answer, and only when the learner clicks
   "Genauer erklären". Regular drill marking is local.
2. **An additional path the audit did not list:** sentences typed into "Satzbau verstehen" (`explainSentence`) are
   also sent. The copy includes it.

Also sent, but not learner free text: task context (situation, Leitpunkte, keywords), the local pre-analysis (word
count, detected register, connectors) and speaking duration. These are not named in the copy to keep it short; they
are generated/derived data, not learner writing.

## Why no retention or storage claim was made

The copy deliberately says nothing about how long the provider keeps the data, whether it stores it, uses it for
training, or deletes it. Reasons:

- **It cannot be verified from this repository.** The code shows only what is sent and to which endpoint. What
  happens after `fetch(.../chat/completions)` is governed by the provider's own systems and terms, which the audit
  could not determine and which I did not (and under the offline boundary could not) check.
- **The endpoint is configurable.** `DEEPSEEK_BASE_URL` can point elsewhere, so even a correct statement about
  DeepSeek would not hold for every installation.
- **Provider terms can change** without any change to this app, so a retention statement in the UI would go stale
  silently.
- A claim like "wird nicht gespeichert" or "sofort gelöscht" would therefore be an **unsupported assurance** to the
  learner — worse than silence, because it invites reliance. The task explicitly forbids it.

For the same reason the copy makes no claim of encryption, anonymisation, safety, legal basis or consent.

## Known gap (not addressed, out of scope)

When the microphone is used, the transcript is produced by the browser's own speech recognition
(`public/js/speech.js`, `SpeechRecognition` / `webkitSpeechRecognition`). In some browsers that service may itself
process audio remotely. That is browser behaviour, not verifiable from this code, so the copy does not mention it.
It should be considered in the human `P-03` review.

## Validation

- `node tools/check.js` — 101 passed, 0 failed
- `node tools/writing-check.js` — 9 passed, 0 failed
- `node tools/feedback-check.js` — 14 passed, 0 failed
- `node tools/repository-check.mjs` on the staged snapshot — passed (253 tracked files, 182 text blobs screened)
- `git diff --cached --check` — clean
- No server, browser, live AI call, `.env` or learner data used. No screenshot taken (browser runs are outside this
  task's boundary); the change is one paragraph in an existing style class.

## Paths changed

- `public/js/ui.js`
- `work/implementation/SEC-03.md`

`public/js/exam.js` untouched. `public/styles.css` not needed.

## Outstanding

- Native-speaker review of the German copy (`C-06`).
- Human `P-03` privacy review, including the browser speech-recognition question above.
- Desktop/mobile visual check of the Settings card when a browser run is authorised.

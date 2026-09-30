# SEC-04 — stop the read routes exposing key characters (fixes F-7)

Execution: `sec-04-hermes-20260930-a` · Worker: Hermes/Docker, slot 2 · Coordinator: `COORD-TAKEOVER-20260930`
Branch: `codex/sec-04-keymask` · Base: `8a71f718ee534851a98d19eece07dab933b56479`

## Finding and severity (kept as the audit rated it)

`server.js` had `maskKey(key) => key.slice(0, 5) + '...' + key.slice(-4)` — nine characters of the stored
API key — and `publicConfig()` served it as `keyMasked`. `publicConfig()` is the payload of the
**unauthenticated** read routes `GET /api/health` and `GET /api/config`, and of the `POST /api/config`
reply (`{...publicConfig(), saved}`).

The server binds `127.0.0.1`, so this was never remotely reachable, and nine characters are not a usable
credential. This is **informational**, not a breach and not a leak of a usable secret. The defect is
narrower than that: a status display does not need any character of the key at all.

## Change

### `server.js`

`maskKey` is deleted (not merely made unused), `keyMasked` is gone from `publicConfig()`, and the startup
banner no longer echoes key characters:

```js
function publicConfig() {
  const s = settings();
  return {
    configured: Boolean(s.apiKey),
    model: s.model,
    baseUrl: s.baseUrl,
    examDate: s.examDate,
  };
}
```

`configured` is still `Boolean(s.apiKey)` and `model` is unchanged, so the Settings page keeps working
offline and online. The function carries a comment naming F-7 and stating that no key material and no
per-key fingerprint may be added back.

### `public/js/ui.js` (one line, appearance preserved)

| | Settings key pill, key configured |
| --- | --- |
| Before | `Verbunden · ${esc(cfg.keyMasked)}` → e.g. `Verbunden · sk-ab…xyz9` |
| After | `Verbunden · Schlüssel gespeichert` |

The pill keeps its `pill good` / `pill warn` classes, its position and its "Kein Schlüssel hinterlegt"
alternative; the model stays in the existing second pill (`Modell: …`) in the same row. Nothing else in
Settings changed — no new field, no new layout, no CSS.

## Why there is no replacement per-key indicator

The learner can no longer compare a fragment to confirm which key is stored. That is deliberate, and no
fingerprint/hash suffix was added:

- The question the fragment answered ("did the right key land?") is answered better by the existing
  **Verbindung testen** button, which performs a real request and reports the result in `#key-status`. A
  three-character echo never proved a working key; the live test does.
- The key lives in `.env` on the same machine and is replaced through the same page (`data-clear-key`),
  so there is no multi-key ambiguity to resolve in this app.
- Any per-key identifier is a new derived value that would have to be stored and reviewed; the task says
  not to invent a new exposure to replace the old one, and a fixed placeholder (`••••`) would only
  pretend to be a mask.

The German string `Verbunden · Schlüssel gespeichert` is new learner-facing text and needs the same
native-speaker review (`C-06`) as SEC-03's copy.

## Evidence — the new probe passes here and fails on the pre-fix server

`tools/keymask-check.mjs` starts the server in-process on an ephemeral loopback port with
`B1PREP_ENV_FILE`/`B1PREP_PROGRESS_FILE` pointing into a throwaway temp directory and a synthetic key
(`Zq7Xv2Rt9Kp4Lm8Wn3Bd6Fh5Jg1Cs0Yt4Ew6` — 36 characters, not `sk-` shaped, never a real key). It asserts
`configured: true` at scan time, so a pass cannot be vacuous.

The scan is **not** written against the old shape. It tests every 3-character run of the key (34 runs):
any disclosed substring of length ≥ 3 contains one of those runs, so a whole key, a prefix, a suffix or a
differently sliced fragment are all caught. The scan is case-insensitive and also runs over every string
value of the parsed JSON with its field path.

`node tools/keymask-check.mjs --prefix-commit 8a71f718ee534851a98d19eece07dab933b56479`:

| Check | this tree | pre-fix `server.js` |
| --- | --- | --- |
| `probe-key-is-synthetic-not-credential-shaped` | PASS | PASS |
| `throwaway-env-file-outside-repository` | PASS | PASS |
| `configured-true-with-key` | PASS | PASS (the key really is live) |
| `status-still-shows-configured-and-model` | PASS | FAIL — field set gained `keyMasked` |
| `health-body-has-no-key-run` | PASS | **FAIL** |
| `health-json-values-have-no-key-run` | PASS | **FAIL** |
| `config-body-has-no-key-run` | PASS | **FAIL** |
| `config-json-values-have-no-key-run` | PASS | **FAIL** |
| `config-post-body-has-no-key-run` | PASS | **FAIL** |
| `configured-false-without-key` | PASS | PASS |
| `detector-flags-the-legacy-mask` | PASS | PASS |
| `repository-env-untouched` | PASS | PASS |

Verbatim pre-fix failures (5/5 leak checks, key live):

```
FAIL  health-body-has-no-key-run  [GET /api/health: disclosed 5 run(s) of >=3 key characters:
      "Zq7", "q7X", "7Xv", "4Ew", "Ew6"]
FAIL  health-json-values-have-no-key-run  [GET /api/health: key characters in field(s)
      $.keyMasked=["Zq7","q7X","7Xv","4Ew","Ew6"]]
FAIL  config-body-has-no-key-run  [GET /api/config: disclosed 5 run(s) ...]
FAIL  config-json-values-have-no-key-run  [GET /api/config: key characters in field(s) $.keyMasked=[...]]
FAIL  config-post-body-has-no-key-run  [POST /api/config: disclosed 5 run(s) ...]
OK    discrimination: pre-fix fails 5/5 leak check(s) while the key is live
```

The three prefix runs and the two suffix runs are exactly the nine characters the old mask returned, and
the JSON scan names `$.keyMasked` as the leaking field. `detector-flags-the-legacy-mask` additionally
proves the detector in isolation: it catches the reconstructed legacy mask string and reports **0 false
positives** on the new payload. The CLI exits 1 if a source that should be caught is not caught, so a
probe that passes on both trees cannot be reported as success.

`tools/keymask-check.test.mjs` runs both directions automatically: 19 tests, including the pre-fix
discrimination run. It materializes the pre-fix file from `git show 8a71f71:server.js` (verified to
contain the pre-fix `maskKey` before use) and imports it from a temp directory that also receives a copy
of `public/js/progress-merge.js`, which `server.js` imports by relative path. If that blob is ever
missing (a shallow import), the test falls back to a clearly labelled synthetic stand-in that reproduces
only the old response shape, and reports which source it used — it never silently becomes vacuous.

## Validation

- `node tools/check.js` — 101 passed, 0 failed
- `node tools/writing-check.js` — 9 passed, 0 failed
- `node tools/feedback-check.js` — 14 passed, 0 failed
- `node tools/server-origin-check.mjs` — 16 checks passed
- `node tools/reset-check.mjs` — 9 checks passed
- `node tools/owned-client-check.mjs` — 31 passed, 0 failed
- `node --test tools/keymask-check.test.mjs` — 19 passed, 0 failed
- `node --test tools/*.test.mjs` — 175 passed, 0 failed (whole suite)
- `node tools/repository-check.mjs` on the staged snapshot — passed
- `git diff --cached --check` — clean

No browser, no live provider or AI call, no database, no deployment, no `.env` and no learner record was
used or written. `repository-env-untouched` asserts the checkout's `.env` was neither created nor modified
(stat only — never opened), and any inherited `DEEPSEEK_*` variable is deleted from the probe process
before `server.js` is imported, so a real key in the developer's environment cannot be served, scanned or
printed by a run.

## Paths changed

- `server.js`
- `public/js/ui.js`
- `tools/keymask-check.mjs` (new)
- `tools/keymask-check.test.mjs` (new)
- `work/implementation/SEC-04.md` (new)

`public/js/exam.js` untouched.

## Deliberately not changed (outside the allowed paths — for the coordinator)

- `public/js/ai.js` line 12 still initialises `status = { …, keyMasked: '', … }`. The server no longer
  sends the field, so it stays the empty string and `ui.js` no longer reads it. It holds no characters;
  the dead field could be deleted in a follow-up task.
- `tools/ai-live.js` line 94 prints `cfg.keyMasked`, which will now print `undefined`. This is a
  developer-only script that needs a real key and never runs in the offline gates.
- `tools/feedback-browser-check.js` line 35 serves `keyMasked: ''` from its mock server; harmless, and
  left alone as a test fixture.
- `docs/`, `tests/`, `spikes/` and the coordination records were not edited; `work/implementation/F-03-A-REPORT.md`
  still describes the old payload shape, which is that report's historical record.

## Outstanding

- Human `P-03` privacy review. This task closes no security or privacy gate.
- `C-06` native-speaker review of `Verbunden · Schlüssel gespeichert`.
- Desktop/mobile screenshot of the Settings card when a browser run is authorised (outside this task's
  boundary; the pill's text is asserted at source level only).

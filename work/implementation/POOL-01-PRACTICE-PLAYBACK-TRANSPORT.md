# POOL-01 — the practice playback transport (task-49)

**Status: DELIVERED, NOT REVIEWED, NOT DEPLOYED.** Branch `codex/practice-playback-transport` off `d65de1a`
(the five commits of `codex/pool-01-listening-release`, which itself sits on `daaff6b`). No production
system, droplet or `/opt/hatoove` path was touched, nothing was pushed and nothing was merged. **No file
under `server/migrations/` was added or edited; migration `0049` remains reserved for the Lead's approval
change.**

## 1. Why this slice exists

Task-48 released `telc-deutsch-b1.hv1.04` / `hv2.04` / `hv3.04` with tracked WAVs, `pool-listening-media.json`
descriptors and `exam_media` rows in migration `0048`. The sets were released and **unreachable**: the
practice serving query still carried FIX-F1's blanket `AND s.media_required = false`, and the client had no
practice player at all (`public/app/part-runner.js` rendered the "recordings exist, the practice playback path
does not" hint instead).

The server transport already existed (`0045-practice-playback.sql`, `server/owned-postgres/practice-playback.mjs`,
the two routes in `server/owned-api.mjs`). This slice is the client half plus the one admission change, so a
learner can actually listen.

## 2. The change set

| file | change |
|---|---|
| `server/owned-postgres/adapter.mjs` | `practiceSetForPart` admits a `media_required` set only when **every** `recordings[]` binding resolves to an `exam_media` row for that exam; plus the `cr.rights_status` → `c.rights_status` typo fix (§4) and the two comments that stated the old rule |
| `public/app/api.js` | `PATHS.practiceAttempts` + `practice.playback` / `playbackEvent` / `media`, mirroring the mock trio (attempt id, `scopedCall`, the same `true, true` raw-bytes read) |
| `public/app/listening.js` | extracted `listeningPlayerMarkup`, `listeningStatusText`, `restoreListeningFocus`, `focusedListeningAction`; the mock controller now uses them, so both players share one DOM and one set of sentences |
| `public/app/practice-listening.js` | **new** — the practice state machine: `begin → bytes → play`, the sitting's own refusal copy, `control()` as the single affordance authority |
| `public/app/part-runner.js` | renders the real player when the served set carries a `recordings[]` binding and the view holds a sitting; keeps the FIX-F1 hint for the set it cannot play; flushes and freezes the player around "Auswerten" |
| `public/app/part-runner.css` | one rule for the mount point (the player supplies its own `card-flat` layer) |
| `public/assets/i18n/practice-messages.js` | eight new keys in all five locales (`partRunnerAudioReady`, `…CheckFirst`, `…Used`, `…Checked`, `…Resume`, `…Loading`, `partRunnerPlayFirst`, `partRunnerResume`) |
| `tools/practice-media-check.mjs` | F4/F4b: the shipped admission query extracted and run, plus two SQL mutations (P1/P2) that remove one half of the rule each |
| `tools/practice-runner-check.mjs` | legs 7e–7i (the player's own states + the runner's composition), mutations M5/M6, a stateful host stub, and a repaired mutation harness |
| `tools/practice-selection-check.mjs` | P8f now asserts *which* sets serve (each HV part serves exactly its `.04` set and by name refuses the other three); P15's mutation narrowed to the playability half alone |
| `tools/pool-01-check.mjs` | P7 asserts the same two halves at release level: the released set serves with its `recordings[]`, the three seeded recordingless sets are not servable |

**Applied migrations `0001`–`0048` were not touched** (`git diff d65de1a..HEAD -- server/migrations` is
empty), `data/seed.json` is untouched, and no migration, tool or check in this slice marks content,
translations or explanations `approved`/`reviewed` — `grep -E "review_status|reviewed|approved"` over the
whole diff returns only the query's own `review_status` filters and the synthetic fixture's `unreviewed`
rows.

## 3. The admission rule, in one sentence

**A `media_required` set is served only when every recording its payload binds resolves to an `exam_media`
row for the same exam** — the same key `practice-playback.mjs#recordingsOf` resolves, so the serving decision
and the playback port agree by construction. Verified against a disposable PostgreSQL with the whole
migration set applied, per family:

| family | served | refused |
|---|---|---|
| `HV1`/`HV2`/`HV3` | the `.04` set (its `recordings[]` binding resolves) | the three seeded sets (no `recordings[]` at all) |
| `LV1` `LV2` `LV3` `SB1` `SB2` | unchanged (6 / 3 / 3 / 4 / 3) | — |

**FIX-F1's protection survives, mutation-proved on both halves.** Removing only the playability clause lets
a recordingless set be served (mutation P1 / selection-check P15); removing only the "every recording" clause
lets a partially bound set be served (mutation P2). `checkPracticeAttempt`'s own `media_unavailable` refusal
is deliberately **unchanged**: a sitting on a recordingless set is still refused over HTTP and writes no
evidence row (F4b).

## 4. One pre-existing defect this slice had to fix, and why

`practiceSetForPart` shipped `COALESCE(cr.basis, cr.rights_status)`, and `content_rights` has no
`rights_status` column. The shipping method therefore raised `42703 column cr.rights_status does not exist`
against any database — introduced in `00f7571` (slice C, part 2) and carried through `d65de1a`. It is why
`tools/practice-selection-check.mjs --postgres` had **never executed a single PostgreSQL leg**: it aborted at
its first setup step ("every released set of the part checked once"), which the `--postgres` path reports as
one opaque FAIL. The typo is on the same query line this slice rewrites, so it was fixed here rather than
left to block the verification; the change is one identifier and every other query in the file already spells
it `c.rights_status`. It is called out because it is pre-existing and the reviewer should see it as such.

## 5. Evidence

- `node tools/run-gates.mjs mirror` → **14/14**; `node tools/run-gates.mjs baseline` → **9/9**;
  `node tools/run-gates.mjs mirror-db` → **7/7** against a disposable `postgres:17-alpine` on
  **`127.0.0.1:55494`** (`POSTGRES_HOST_AUTH_METHOD=trust`, database `hatoove_playback`,
  `OWNAPI_PG_ALLOW=1`; container removed afterwards). Ports checked free before use; 5432, 62563, 55489 and
  55493 were never touched.
- `node tools/practice-media-check.mjs` → **21 legs, 0 failed**, with **6 mutations** (M1–M4 pre-existing,
  P1/P2 new), each failing **exactly the intended leg**.
- `node tools/practice-runner-check.mjs --mutations` → **43 passed, 0 failed**; **6/6 mutations** fail exactly
  the intended leg (`M5 -> 7g`, `M6 -> 7f`).
- `node tools/practice-selection-check.mjs --postgres` → **47 legs, 0 failed** (with the six pure-rule
  mutations and P15/P19).
- `node tools/pool-01-check.mjs --postgres` → **16 legs, 0 failed** (with the twelve source/builder/media
  mutations of task-48).
- `node tools/exam-s5-client-check.mjs` → 27 checks passed; `exam-s5b-client-check.mjs` → 19 — the mock
  player's own suite, re-run because `listening.js` was refactored.
- **Rendered evidence, in a real browser, for the module this slice refactored**:
  `node tools/exam-s5b-browser-check.mjs` → **8 passed, 0 failed**, headless Chromium against a disposable
  source-only Compose stack (project `hatoove-s5b-browser-1791239223352-42200`, app on `127.0.0.1:63402`,
  database `127.0.0.1:63403`; it wrote 12 screenshot files under the gitignored `.qa/exam-s5b/…`, which were
  then deleted because `.qa/` belongs to another agent, and the stack was removed with both ports verified
  free). It is the mock listening player's own rendered acceptance, and it drives
  `public/app/listening.js` — the module from which `listeningPlayerMarkup` was extracted — through
  boundary playback in Chromium at desktop and phone widths. **It does not render the PRACTICE player**:
  the browser journey it walks is the mock/reading one and no browser check in this repository opens a
  practice listening set, so the practice player's rendered path is `7i`'s markup composition plus this
  module-level browser proof, not a browser render of the practice block itself.

### Mutation evidence (which mutation, which leg, by name)

| mutation | what it removes | leg that must fail | file |
|---|---|---|---|
| P1 | the playability half of the admission rule | F4 leg (`s5.tech.hv1.none must stay REFUSED`) | `practice-media-check` |
| P2 | the complete-resolution half | F4 leg (`s5.tech.hv1.mixed must stay REFUSED`) | `practice-media-check` |
| M5 | the client's reading of `practice_check_required` | `7g the refused second listen is shown as the server's own decision, never as an available play` | `practice-runner-check` |
| M6 | the `begin → bytes` order (bytes fetched first) | `7f the practice transport: the client asks for the bytes only AFTER the server acknowledges a play` | `practice-runner-check` |
| P15 | the playability half, in a copy of the whole `server/` tree | P15's own reproduction: the mutated copy serves `telc-deutsch-b1.hv3.0[123]` and `POST /practice/check` answers 404 with the sitting committed | `practice-selection-check` |
| — | (the assertions whose guard is the rule itself; they fail by name when it is removed) | `F4b`, `P8f HV1/HV2/HV3`, `P7 SQL … only a PLAYABLE one is served` | `practice-media-check`, `practice-selection-check`, `pool-01-check` |

Two harness repairs were needed to make the proof trustworthy rather than merely green, and both are
disclosed because they are outside the slice's subject:

1. `practice-runner-check --mutations` spawned the **file the mutation touched** as the module under test.
   M1–M4 mutate `part-runner.js` so this was invisible; M5/M6 mutate `practice-listening.js`, and the child
   then imported the player as if it were the runner (every leg failing with
   `runner.createPartRunnerView is not a function`). The child now always spawns `part-runner.js`, the copy
   directory is recreated per mutation (`cpSync` merges into an existing tree), the child has a 120 s timeout
   reported as a failure instead of a hang, and an incomplete copy fails by name.
2. `practice-listening.js` polls its playback position with `setInterval` and clears it in
   `resetAudio`/`dispose`. A mutated copy that forgot to clear one kept the **check's** Node process alive
   after the last assertion, so a mutated run hung instead of reporting a leg. The interval is now `unref()`d
   — a progress poller is not a reason for a document (or a check) to stay alive, and the browser behaviour is
   unchanged.

## 6. Not done / owed — what a human must still do

1. **Listen to the three recordings** and read the scripts against the keys, exactly as task-48 §5.1 says.
   Nothing here is content-approved; this slice adds no review decision and changes no `review_status`.
2. **Nothing was deployed, pushed or merged**; `main` is untouched at `daaff6b`. The three sets are now
   *reachable* by the shipped practice path, which is a change in what a learner meets — the Lead owns the
   second-deploy decision recorded in `POOL-01-LISTENING-RELEASE-CONSTRAINT.md`.
3. **The per-part wrap figure changed for HV1–HV3.** `practiceSetForPart` returns `round.setCount` as the
   number of *served* candidates, so an HV part now reports `setCount` **1** (the `.04` set), not 4: after
   that one set is checked, the next tap wraps ("Alle Sätze dieses Teils geübt — von vorn") instead of
   offering a seeded set. This follows directly from the required rule (the seeded sets are not servable), and
   `HV1.04`'s own DTO is what carries the wrap notice, so nothing is *untrue* on screen — but the HV part's
   pool reads as one set rather than four, and a follow-up may want `setCount` to report the released pool of
   the part, or the seeded HV sets to gain recordings. Flagged, not silently accepted.
4. **No browser render of the PRACTICE player, and no device evidence.** Every leg for the practice path is
   offline (Node) or against a disposable database. The composition leg (7i) proves the runner renders the
   player into its mount point and touches no mock route, but it **does not dispatch a real click through the
   DOM and does not render CSS**; the one rendered proof in this slice
   (`exam-s5b-browser-check.mjs`, 8/8) drives the *mock* player in Chromium, which is the module that was
   refactored, not the practice block. No browser check in this repository opens a practice listening set, so
   a rendered practice-player proof needs a new browser journey
   (`app-browser-check.mjs` is Docker-dependent and is not a CI gate); audio playback on a physical
   device/keyboard remains untested and untestable here. **Nothing in this slice is phone evidence.**
5. **`partRunnerReplay`** in the practice catalogue is now unused by `public/app/` (the player renders its own
   Replay control from the shared labels); it is still referenced by
   `tools/practice-runner-check.mjs`'s key list and by nothing else. Kept rather than deleted — removing a
   shipped key is a copy decision, not this slice's.
6. **The drill's listening sets are still refused by design.** `server/drill-sets.mjs`'s candidate query and
   `readSet` keep `media_required = false`, so a learner who has practised `hv1.04` will not be handed the
   same recording through "Fehler üben" for those items. That is the conservative direction (no unplayable
   drill item), but it is a consequence worth a decision: the drill could now serve the `.04` recordings on
   the same playability rule the practice path uses.
7. `exam-s0-server-pg-check.mjs` and `explanation-admission-pg-check.mjs` are hard-guarded to port 62563 and
   were **not run** (that port is another check's).

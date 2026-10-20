# Android listening fixes — 20 October 2026

Execution: `ANDROID-LISTENING-FIX-20261020-A`; independent read-only reviewer:
`ANDROID-LISTENING-FIX-20261020-R1`. Base: `981f8aea134a61d34325d0e4de30c56ac3adcd15`.
Branch: `codex/android-listening-fixes-20261020`.

Status: implemented, independently reviewed CLEAR, all five required hosted checks
green, and [PR174](https://github.com/ronslink/hatoove/pull/174) merged at
15:38:17 UTC. Final reviewed head `e177d9f36f36207cb57c048e000fe479bf3cbe80`
merged as `2774aab53d73e779aa561b907961ae2c34c1a939`. Runtime source is pinned
by `ae168bdf2f7077992ab0a5a83ff8c7f33880358d`; the subsequent commit changes only
tests and records. No production deployment was requested or performed.

## Changes

- Fresh persistent PostgreSQL initialization now imports the bundled v2 listening
  package with its playback rules. Initialization uses the existing per-exam lock
  and activates only a missing release head. An existing v1, v2 or newer/withdrawn
  head is preserved, including when the media root is unavailable. Failed media
  verification leaves no new head or partial listening content; retry can succeed.
  Explicit publication retains its prior activation semantics. Historical
  disposable fixtures keep their deliberate v1 baseline.
- The shared listening renderer waits for a valid playback limit before rendering
  the parameterized rule. Loading and failure states no longer expose `{maxPlays}`
  or an unresolved translation fallback.
- The practice player uses the existing translated Pause, Resume and Reload labels
  for the corresponding actions in all five interface languages.
- Answer badges expand for authored word identifiers such as `richtig` and
  `falsch`, with wrapping available for longer identifiers.
- The phone retest uncovered an additional pause/resume defect: native audio
  resumed while the server remained paused. Resume now acknowledges the existing
  recovery transition, rotates playback identity without consuming another play,
  and retains buffered media. Pause samples the actual audio position even after
  local playback stops, halts immediately during an in-flight checkpoint, and
  does not claim success when the preceding save fails.

No migration, authored question, audio asset, allowance policy or production learner record
was changed. Existing persistent release heads are intentionally preserved;
this is not an automatic upgrade of an existing installation.

## Verification

| Check | Result |
| --- | --- |
| Offline baseline (`run-gates.mjs baseline`) | 14/14 on the final source snapshot |
| Staged repository guard and whitespace | Passed; 844 tracked files and 745 text blobs screened; not a complete secret audit |
| Practice runner | 45/45, including real server transitions for resume, identity/allowance preservation, exact pause positions and pause during a held checkpoint |
| Practice locale | 18/18 |
| Shared listening client (`exam-s5-client-check.mjs`) | 27/27 |
| Formal register | 10/10 |
| Package PostgreSQL (`exam-s2-package-pg-check.mjs`) | 16/16, including fresh/concurrent/repeated initialization, missing media and preservation of existing heads/data |
| Listening package PostgreSQL | 15 reported passes; optional real-package leg skipped because its media-root option was absent |
| Full fresh Docker stack | 41/41; HV1/HV2/HV3 playback limits 1/2/2, begin and protected WAV requests pass without manual import; repeated migration preserves an exact saved multiline draft |
| Docker OpenAPI check | 56 routes, zero errors |
| PostgreSQL mirror gate group | 11/11 after correcting the old inventory assertion; pool check 16/16 plus its mutation proofs |
| Complete-exam browser (`exam-s5b-browser-check.mjs`) | Final 8/8 after waiting for enabled audio Load and effectively writable answer/Save controls |
| Independent review | R1 CLEAR for final committed head `e177d9f`, runtime, focused regressions, test-only corrections and all desktop/phone captures; all five changed runtime files independently match the physical fixture byte-for-byte |
| Required hosted CI | All five jobs passed on `e177d9f`; durable/runtime completed in 7m59s; the scheduled rendered job was skipped as configured |

Real-package behavior is covered by the package-initialization and fresh Docker
checks, independently of the optional skipped leg. The full Docker check verified
cleanup of its own containers and volumes.

The initial hosted durable job failed the pool check's old global v1 inventory and
rights-row assumptions. Its correction keeps the exact 31-set v1 corpus and all
original per-batch rights assertions, checks the exact nine added v2 sets, and
requires the only 18 rows without a later rights override to match the imported
package's identities, source locators, declared rights and content hashes exactly.
The release hash, publisher and complete public sets/media projections are also
checked. No rights decision is fabricated: the existing immutable override remains
available for a later veto.

Supplemental historical browser suites are **not green**. S3 reports 2 passed /
4 failed, S4 reports 2/2, and S5 reports 10/2. Every named outcome matches a fresh
run on unchanged base `981f8aea`. Failures include old status/route selectors and
an S5 practice-allowance assertion that contradicts its own fixture. Their
initialization/import checks pass; full historical UI coverage is not claimed.
S5b initially produced inconsistent boundary/readiness failures on both base and
candidate. Its harness now waits for effectively enabled controls before actual
pointer input; all exact answer-count, finalization and native-audio assertions
remain intact, and the final candidate run passes 8/8. The retained diagnostics
do not establish that every earlier failure had the same cause.

Desktop evidence uses an isolated browser and source-only Docker fixture. Physical
evidence uses a Samsung Galaxy S24 Ultra (SM-S928B), Android 16, Chrome 155, at a
384 CSS-pixel portrait viewport. ADB was connected wirelessly; USB debugging was
not established. All accounts, answers and playback rows in this fixture are
synthetic. No live AI or payment call was made.

The phone shows an interpolated one-play instruction, Pause while playing and
Resume while paused. Both word badges fit without overflow. On a fresh attempt,
the first pause saved 3278ms. Resume rotated the playback identity, accepted a
checkpoint at 13346ms and kept `plays_used=1`. The next pause saved 25192ms,
exactly matching the handset's measured progress value, still with one play used.

Local evidence is retained outside Git under `.qa/android-listening-fix-20261020/`:

- `android-listening-playing.png`, `android-listening-paused.png`
- `android-answer-badges.png`, `desktop-answer-badges.png`
- `desktop-listening-ready.png`
- `android-resume-conflict.png` (before the additional correction)
- `android-resume-fixed.png` (successful fresh-attempt retest)

The preceding physical session's report is
`.qa/android-physical-20261020/RESULT.md`. Ron confirmed audible German audio,
continued background playback, successful typing and reachable Submit in that
session. This correction round does not claim a new human audibility test.
Native Return was not independently observed and remains unverified; no Return
defect is inferred. Accepted practice-page reload creates a new attempt under the
existing contract; this work does not claim same-attempt reload recovery.

## Remaining boundaries

Canonical main was cleanly fast-forwarded to the integration commit. Its first
parent is `76ddd4f92da4bc7db384d4bfe8c41a33fd61e9dd`, which includes independently
merged PR172/173; their changes are preserved and are not attributed to this task.
The implementation base remains `981f8aea`.

The physical/desktop fixture's five containers exited successfully, with its
synthetic volume and local evidence preserved. Both temporary PostgreSQL
regression instances were removed after ownership checks. All eleven
supplemental/baseline/retry browser projects were independently verified to have
zero remaining containers and volumes. Owned ADB mappings and the isolated
headless browser were removed; the comparison worktree is archived. No original
learner volume or production service was changed.

Source delivery, independent review, hosted CI, integration, production deployment
and product acceptance are separate statuses. iPhone keyboard/audio, qualified
content/audio review, native-language review and broader learner/product
acceptance remain open. Existing legal requirements are unchanged.

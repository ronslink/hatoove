# CI-GATES-01 — wire the ungated checkers into CI

| | |
|---|---|
| Task / execution | CI-GATES-01 / `ci-gates-01-claude-20261001-a` |
| Worker | Claude for Windows (local), coordinator `COORD-TAKEOVER-20260930` |
| Base | `origin/main` @ `5a63429949275f4cb27cd7f64565afe8cf029511` (re-checked with `git fetch origin` + `git rev-parse origin/main` before editing) |
| Branch | `codex/ci-gates-01` |
| Allowed paths used | `.github/workflows/ci.yml`, `work/implementation/CI-GATES-01.md` |
| Not touched | `.github/workflows/pilot-contracts.yml` (its `postgres` job is unchanged), `tools/**`, `server/**`, `public/**`, `server.js`, `package.json`, plans, board |
| Status | Checkers wired and proven to bite locally. **CI result on the PR is recorded only if observed.** Closes no security or exam-validity gate. |

## What changed

All new gates live in `ci.yml`; `pilot-contracts.yml` is left for the PostgreSQL job, which is the only place an
install is allowed. Nothing it runs is duplicated: it runs `owned-api-check --backend=postgres`, the new job runs
the memory backend (previously ungated).

| Job | Runs on | Steps (each fails the job on non-zero exit) |
|---|---|---|
| `baseline` (unchanged) | ubuntu + windows | repository-check, check.js, writing-check.js, feedback-check.js |
| `contracts` (new) | ubuntu + windows | server-origin-check, reset-check (no flag), revision-check, keymask-check, keymask-check `--prefix-commit 8a71f718…`, progress-equal-check, draft-session-check, owned-api-check (memory), owned-client-check |
| `fixtures` (new) | ubuntu | feedback-case-check, objective-fixture-check, exam-blueprint-check |

`contracts` checks out with `fetch-depth: 0`. That is required, not cosmetic: `revision-check` and
`progress-equal-check` materialize the pre-fix tree with `git show <sha>:<file>` and, on a shallow clone, exit 1
with `could not materialize the pre-fix tree` (reproduced locally in a `--depth 1` scratch clone). They fail
loudly, so a default checkout would have made CI red, not silently green.

The extra `keymask-check --prefix-commit` step exists because the default `keymask-check` run does no
discrimination (it says so in a NOTE); the flagged run also probes the pre-fix `server.js` and exits 1 if the probe
fails to catch it. The commit is passed explicitly.

No secrets, no network, no installs, no `continue-on-error`, no `|| true`, no `--legacy-root`. Action SHAs are
the same pinned ones the existing jobs use; Node `'24'`.

## Local run, same order as CI (Windows, Node v24.4.1, tree @ 5a63429)

| Command | Exit | Result |
|---|---|---|
| `node tools/repository-check.mjs` | 0 | passed: 286 tracked files; 215 text blobs screened |
| `node tools/check.js` | 0 | 101 passed, 0 failed |
| `node tools/writing-check.js` | 0 | 9 passed, 0 failed |
| `node tools/feedback-check.js` | 0 | 14 passed, 0 failed |
| `node tools/server-origin-check.mjs` | 0 | 16 check(s) passed |
| `node tools/reset-check.mjs` | 0 | 9 check(s) passed |
| `node tools/revision-check.mjs` | 0 | 8 check(s) passed, incl. discrimination against the pre-fix tree |
| `node tools/keymask-check.mjs` | 0 | 12 check(s) passed |
| `node tools/keymask-check.mjs --prefix-commit 8a71f718…` | 0 | 12 passed; pre-fix fails 5/5 leak checks (discrimination OK) |
| `node tools/progress-equal-check.mjs` | 0 | 10 check(s) passed, incl. discrimination against the pre-fix tree |
| `node tools/draft-session-check.mjs` | 0 | 17 passed, 0 failed |
| `node tools/owned-api-check.mjs` | 0 | 24 passed, 0 failed (backend: memory) |
| `node tools/owned-client-check.mjs` | 0 | 31 passed, 0 failed |
| `node tools/feedback-case-check.mjs` | 0 | structurally sound (6 warnings) |
| `node tools/objective-fixture-check.mjs` | 0 | structurally sound (0 warnings) |
| `node tools/exam-blueprint-check.mjs` | 0 | internally consistent (0 warnings) |

## Proof the gate bites (scratch copy outside the repository)

`D:\hatoove-work\ci-gates-scratch-bite` was a plain copy of this checkout. Each breakage was applied with `sed`,
the command run, then reverted with `git checkout -- <path>` before the next. Nothing was committed or pushed.

| # | Deliberate breakage | Command | Exit | First failure |
|---|---|---|---|---|
| A | `server.js`: same-origin guard disabled | server-origin-check / reset-check | 1 / 1 | foreign Origin: expected 403, got 200 / `delete-requires-same-origin` |
| B | `publicConfig()` returns `keyMasked` again | keymask-check | 1 | `health-body-has-no-key-run` |
| C | `progressEqual` back to plain `JSON.stringify` compare | progress-equal-check | 1 | `equal-for-fresh-empty-state` |
| D | `owned-api.mjs`: unchecked mutation no longer 403 | owned-api-check | 1 | `error-403-mutation-without-origin-gate` (23/1) |
| E | blueprint part `points` 25 → 24 | exam-blueprint-check | 1 | 2 error(s) |
| F | `server.js`: writes older than the last delete accepted | revision-check | 1 | `stale-write-is-refused-with-409` |
| G | owned client `credentials: 'include'` | owned-client-check | 1 | exact allowlisted request options |
| H | draft session saves over an unresolved conflict | draft-session-check | 1 | `stale-save-rejected-writes-nothing` (16/1) |
| I | duplicate objective family id `LV2` → `LV1` | objective-fixture-check | 1 | `family.duplicate-id` |
| J | duplicate feedback case id `WFC-02` → `WFC-01` | feedback-case-check | 1 | `case.duplicate-id` |
| K | shallow (`--depth 1`) clone, no breakage | revision-check / progress-equal-check | 1 / 1 | could not materialize the pre-fix tree |

Under breakage D, owned-client-check and draft-session-check stayed green. That is expected (they drive the
client, which always asserts the origin), not a wrong-reason pass; G and H break them directly.

## Not verified / notes for the coordinator

- The Linux legs were not run locally; only Windows. The PR's CI run is the first Linux evidence.
- `feedback-case-check` passes with 6 warnings; warnings do not fail the job (by the checker's design).
- The checkers' own `node --test tools/*.test.mjs` suites are still ungated (only
  `owned-api-pg-check.test.mjs` runs, in `pilot-contracts.yml`). Out of scope for this slice.
- Browser/e2e tools (`e2e.js`, `*-browser-check.js`, `redesign-check.js`, `tts-check.js`, `sync-home-check.js`)
  are not gated; they need a browser or a provider and were not in the brief.
- `revision-check` and `progress-equal-check` accept `B1PREP_PREFIX_BASE` / `B1PREP_PM01_PREFIX_BASE` env
  overrides for the pre-fix commit. CI sets neither.

# Hatoove agent instructions

**Working language (Ron, 3 October 2026):** code identifiers, comments, developer logs, technical documentation and agent coordination use English unless Ron explicitly specifies otherwise. Keep required learner-facing translations and exam-language content in their stipulated languages. New technical routes use English names; the payment route is `checkout`.

## Canonical workspace

Ron relocated local work to **D:\Hatoove** on 1 October 2026. Use this repository for new local work; read `docs/WORKSPACE_LOCATION.md`. The design reference is `D:\Hatoove\design`, and the shared coordinator handoff is `D:\Hatoove\handoff\ron-agent`. Earlier OneDrive/D-drive paths in historical records are recovery references. Keep local handoffs, design originals and `.qa` recovery material out of commits. Relocation does not resume paused work or renew any lease.

**Runtime direction (Ron, 1 October 2026):** Docker Compose is the supported execution path for the server, worker, migrations and PostgreSQL. Do not restore the retired host launcher or installer. Preserve existing data volumes; this change does not authorize production deployment.

## Product and design

Hatoove is standalone exam preparation, initially for telc Deutsch B1 reading, language elements, listening and writing. Speaking, STT, school administration and overall-exam pass predictions are outside the pilot. **`PILOT_BUILD_PLAN.md` governs scope**, [MASTER-PLAN.md](MASTER-PLAN.md) sets delivery order and records progress, and `work/implementation/MFP-DESIGN-DECISIONS.md` supplies design/state acceptance. The writing-first minimum functional product and its `FUNCTIONAL-ROADMAP.md` are withdrawn — see MASTER-PLAN §10. **The product is multi-exam:** telc Deutsch B1 is the first exam package and recognised English tests are the next candidate, so keep the exam package, exam language, instruction language and purchasing market independent. Build the small new vanilla client under `public/app/`, then retire the old SPA. No framework or hosting migration is implied.

Use the supplied designs in `D:\Hatoove\design` as the new learner-app visual direction (Ron, 1 October 2026), following `work/implementation/DESIGN-WIRE-01.md`. The orange/rising-oo design replaces the former palette/type preservation rule; keep one consistent system across all retained views. **Language change (Ron, 3 October 2026):** landing/pre-auth pages, menus, account screens and app guidance follow selected de/en/uk/ar/tr. Original exam-language content and directions remain intact; operational directions additionally show the selected-language translation. Arabic interface uses RTL with explicit exam-language/LTR islands for German content. This supersedes German-only interface preservation; follow `docs/contracts/PILOT-I18N-INTERFACE.md`. Each UI change needs desktop/mobile evidence; emulation does not replace iPhone/Android keyboard/audio checks. Read the relocated design reference; curate assets/licences into tracked assets rather than importing the older live checkout.

**SaaS-only data/runtime (Ron, 1 October 2026):** remove the prior single-user schema and linked functionality. Use session-derived ownership in one shared PostgreSQL schema; no default local user, progress files, global browser-state blob, file-sync engine or startup fallback to the single-user app. Removing code/schema assumptions does not authorize deleting existing learner records or the live install. PILOT-03 implements the cutover with safe forward migrations and negative acceptance checks, recorded in `work/implementation/RETIRED-CHECKS.md`; it supersedes the separate SAAS-RETIRE-01 slice. Retain useful exam behavior through the new contracts; old single-user compatibility assertions are superseded.

First-release design defaults are email/password registration, per-criterion practice feedback without a /45 total and no daily-time setting. R11 remains an explicit rubric contract decision; never relabel four internal criteria as three telc criteria. No readiness, streaks, study-plan or reminder UI, automatic Leitpunkt ticks or two-model claim. **A payment path and a purchase screen are in scope** (Ron, 3 October 2026: Stripe is the payment method — see `work/implementation/STRIPE-PAYMENT-PATH-01.md` and `work/implementation/PAYMENTS-SLICE-01.md`). Include missing async/history/reset/delete/legal/error states. Logo provenance is AI-generated for this project; curate verified font licences and full de/en/uk/ar/tr coverage.

## Coordination

**Coordinator ownership (2026-09-30, issue [#27](https://github.com/ronslink/hatoove/issues/27)).** Ron
appointed his locally controlled agent as coordinator, taking over coordination between the Hetzner OpenClaw
agent and the local Docker Hermes agent. That instruction **supersedes earlier wording that only the original
Codex chat could coordinate**. The coordinator owns architecture, shared contracts, major learner journeys,
bounded task assignment, scope/lease decisions, central records, integration and user updates, and may
implement work directly. The original coordinator's own implementation is paused; its unfinished changes stay
preserved and unmerged. Coordination continues until Ron changes it, but **each worker execution still needs
its own explicit bounded lease**.

The Hetzner OpenClaw agent and local Docker Hermes agent take bounded assignments and independent reviews.
Read `docs/AGENT_WORKFLOW.md` and the assigned task before editing.

Only the coordinator assigns tasks, changes the central board and determines merge order. A task has one
active owner and an execution ID, base commit, branch, allowed paths, acceptance criteria and next checkpoint.
Workers acknowledge the assignment before editing. A stale assignment does not authorize continued edits or a
merge. Preserve work and report blockers; do not silently abandon or overwrite it.

**A reviewer must not be the author of the slice under review.** The coordinator maintains `CURRENT.md` and
`QUEUE.md` in the shared handoff every five minutes without sending repetitive chat updates, and updates
`IMPLEMENTATION_PLAN.md` and `work/BOARD.md` together after meaningful transitions. Keep status labels
distinct: **delivered ≠ independently reviewed ≠ green CI ≠ merged ≠ product accepted.**

Start with at most four active agents across all hosts, counting coordinator, parents, children and reviewers.
Hermes child spawning is disabled for this project until capability checks succeed and the coordinator
allocates a slot. No recursive delegation by workers. A child that edits files gets a separate
checkout/worktree and branch, even when its container is shared. Never assume conversation isolation means
filesystem isolation.

## Git and file ownership

The private repository is `ronslink/hatoove`. Use a separate clone on each host and a separate worktree for every concurrent writing task. Never share a writable checkout through OneDrive or the G drive between running agents. Branches use `codex/<task-id>-<description>`. After the initial baseline, integrate through pull requests; never force-push main or rewrite another worker's branch.

Edit only assigned paths. Ask the coordinator to resolve overlaps or interface changes before editing shared files. In particular, `public/js/exam.js` must not have concurrent owners. Do not mark content approved; qualified human review remains necessary. The coordinator may resolve routine implementation choices within the user's authorized scope without asking Ron again.

Do not commit credentials, learner records, machine configuration, agent memory, raw provider runs, private browser state or the older `D:\B1_Prep` checkout. Run `node tools/repository-check.mjs` on the staged snapshot before pushing. It catches common problems, not every possible secret. Review the staged file list as well.

## Validation and boundaries

Safe offline baseline commands (updated 2 October 2026 — the three legacy client checks that used to be
listed here were retired with the SPA they tested, in SPA-RETIRE 4; the row in
`work/implementation/RETIRED-CHECKS.md` records why, and the recorded baseline is now this set rather
than 101 + 9 + 14):

```text
node tools/repository-check.mjs
node tools/design-check.mjs
node tools/retired-surface-check.mjs
node tools/seo-check.mjs
node tools/server-origin-check.mjs
node tools/keymask-check.mjs
node tools/owned-api-check.mjs
node tools/owned-client-check.mjs
node tools/i18n-register-check.mjs
```

`i18n-register-check.mjs` was added on 5 October 2026 with REDESIGN-01-COPYFIX. Eight legs fail when: any
shipped German string uses the informal address; a pre-JavaScript inline default disagrees with the
catalogue value that replaces it; either half of the public hero pair is informal; the allowlist stops being
exactly the one documented quotation; a namespace loses or empties a key in any of the five locales; a
shipped file declares an inline default the scan does not cover; the authored writing stimulus changes; or a
2nd-person-singular verb form appears that the curated word list does not know. It scans the shell,
practice, public, auth **and instructions** catalogues, the `data-i18n` / `data-practice-key` inline text,
the `data-i18n-aria-label` / `-title` / `-placeholder` / `-alt` attribute family, the `<noscript>` German and
the JSON-LD FAQ.

It exists because the `du` → `Sie` pass converted the i18n catalogues but not the inline defaults, which put
"Du hast Deutsch gelernt. Jetzt üben Sie, es in Prüfungsaufgaben anzuwenden." on the public front door and
left strings welding an informal imperative to a formal pronoun.

Two honest limits. The word list is curated and R8 only covers the -st family, so a brand-new informal form
outside both would still pass. The one allowlisted exception is `public.checklist2`, which quotes the word
„du"; `public/site.js` carries an authored writing stimulus whose "du" is exam language, not interface copy,
and the check asserts that sentence is unchanged.

`docker-stack-check.mjs` and `app-browser-check.mjs` need Docker and a browser and are NOT CI gates;
`owned-api-check --backend=postgres` and the other PostgreSQL checks need a disposable database. These
test contracts and legacy behavior, not exam validity. Add focused tests for changed behavior; do not preserve an incorrect exam rule just to retain a test result.

Do not run live AI or recovery scripts as automatic setup. The current `server.js` reads `.env` even in offline mode, and the provider key is server configuration that must never be settable or readable from a browser. Browser tests require a disposable source-only checkout, synthetic progress and explicitly isolated ports. Never point generic tests at the learner's existing app. The portable-build, synchronization and file-recovery scripts are **removed**: this is a hosted application with one authoritative server copy.

Keep reviewed tasks/audio versioned, mark objective answers deterministically, preserve unassessed writing failures and save drafts/submissions/results/revisions. The saved DeepSeek benchmark supports provisional formative feedback, not calibrated readiness scores. Runtime fallbacks need separate evaluation.

An independent reviewer checks the diff and evidence before integration. Security-sensitive code requires the human reviews specified in its task. Preparing code and local tests is authorized; publishing the site, changing live DNS, production deployment, new production access and **charging real money (live payment keys, live mode)** require explicit user authorization. The payment path itself is in scope: build and test it in the provider's test mode.

Report the task/execution ID, commit or PR, tests, screenshots where relevant, outstanding risks and next action. A code change is not done merely because an agent returned a summary.

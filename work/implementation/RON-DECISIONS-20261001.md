# RON'S CONFIRMED PRODUCT DECISIONS — 2026-10-01

Verbatim, in Ron's numbering:

> **1. multitenant 2. provider key should not be visible to the user its a server config item, 3. hard delete
> 4. language is a setting the user can control 5. Confirmed sync is nolonger needed**
>
> **language refers to the explanation language the menu and the content remain german**

These are **closed**. Nothing below is open for an agent to reinterpret, and any record that still asks these
questions is stale and must be corrected rather than answered again.

## 1. Multitenant — confirmed

One **service** serving many tenants. Already the built shape and the proven one: **one PostgreSQL database, one
application schema, every tenant's rows in the same tables, isolation carried by `owner_id` + `FORCE ROW LEVEL
SECURITY`** with restricted `NOBYPASSRLS` login roles (`MULTI-USER-TRANSITION.md` §5.0). Adding a user adds
**rows**, never schemas, roles or migrations.

## 2. Provider key is a server configuration item, invisible to the user — confirmed, and already implemented

Acceptance criteria **D1** in `PROVIDER-CONFIG-01.md`, and **implemented and verified** in
`provider-config-01` (merged into the platform branch, checks re-run by the coordinator): `POST /api/config`
refuses `apiKey`/`baseUrl`/`model` with `403 provider_config_is_operator_only` and writes nothing;
`GET /api/config` returns only the learner's `examDate`; `GET /api/health` is a bare `{ok, node}` liveness probe;
and the Settings view offers **no provider field of any kind**. `provider-config-check` 11/11.

**Still open from issue #63's S2, and it is a different thing:** the **paid proxy** `/api/ai` still accepts
**anonymous** requests and a **caller-selected model**. Hiding the key is not the same as protecting the
operator's balance. That is `SAAS-RUNTIME-01`, running now.

## 3. Hard delete — confirmed

**D3**: deleting an account removes the rows. No soft-delete, no grace window, no application-created retained
copy. What the code cannot reach — an operator's own database backups — must be **stated plainly**, not implied
away. Order-of-operations and the `attempts ⇄ submissions` foreign-key cycle are mapped in
`BRIEFS-20261001/HARD-DELETE-01.md`.

## 4. Language is a user-controlled setting — confirmed, **and now precisely scoped**

Ron's clarification is the important part, because it is easy to build the wrong thing:

> **Language refers to the *explanation* language. The menu and the content remain German.**

| Element | Language |
|---|---|
| **Navigation, buttons, labels, the app's own voice** | **German. Not translated. Not a setting.** |
| **Exam content** — the blueprint, the reading/listening passages, the writing prompts, the vocabulary, the guides | **German. This is the exam.** Never translated, never negotiated |
| **Explanations and feedback about the learner's work** — why an answer is wrong, grammar commentary, the formative writing feedback | **the learner's chosen language.** *This* is what the setting controls |

**Consequences that follow, and they are acceptance criteria rather than advice:**

1. **The setting cannot change the interface.** Switching it must not translate a single button, card title or
   menu item. A checker should prove the navigation strings are identical before and after a change.
2. **The setting cannot change content.** Passages, prompts and vocabulary are exam material; a "language" setting
   that swapped them would be a correctness defect, not a feature.
3. **It does change explanations**, and only then is it a feature at all. Issue #63 is explicit that a stored field
   that changes nothing is not a feature, so the slice must show a learner-visible explanation arriving in the
   chosen language.
4. **It belongs on the learner settings page** alongside exam date, daily goal and theme — i.e. the account-scoped
   settings record that already exists (`GET`/`PUT /api/v1/settings`), **not** the browser.
5. **The prompt must carry it.** Explanations are produced by the provider, so the chosen language has to reach the
   request the server makes. This is exactly why issue #63 requires **provider prompts to move to the server** —
   a client-supplied prompt language is a client-controlled prompt.
6. **`C-06` native review still gates the copy.** The feature can be built and tested with synthetic fixtures; a
   human native speaker must review the explanation wording before it is called acceptable. That gate is not closed
   by the setting existing.

## 5. Sync is no longer needed — confirmed

Already executed: `tools/sync-home*.js`, the portable build, `portable/**`, `tools/recover-progress.js` and the
`recover` npm script are **deleted**, `start.cmd` is gone, and `AGENTS.md` / `docs/REPOSITORY_BASELINE.md` no
longer describe any of them. `mergeProgress` is **not** sync and is not covered by this confirmation — it is a
conflict policy for two writers of one row, and it retires **with** the file-persistence model
(`PROGRESS-MERGE-DECISION.md`).

## 6. What remains genuinely open

Not product decisions — the things no agent may close:

- **`P-03` / `X-01`**: security, privacy and legal review. Issue #63 states explicitly that it is **not** a
  production-security approval.
- **`E-01`** exam fidelity, **`C-04`** audio rights, **`C-06`** native language review, and **real-device** evidence.
- **Operations for a hosted service**: migrations vs request privileges, readiness, graceful shutdown, the durable
  worker runner, backups and restore, and the deployment's public origin (issue #63 S5–S7). These are **work**, not
  decisions, and they are ordered in issue #63 as steps B, C and D.

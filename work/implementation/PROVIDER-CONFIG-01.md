# PROVIDER-CONFIG-01 — the provider becomes operator-only, and Settings becomes learner-only

| | |
|---|---|
| Decided by | Ron, 2026-10-01, in three sentences: *"not only does the provider move to server configuration it becomes not visible to the user. settings page must move to a more user based settings page like what language the user gets explanations in"* · *"delete is a hard delete"* · *"we dont need start.cmd anymore period. This application now needs to work like a traditional SaaS app; features that are tied to the way the previous app was used should be removed and we should move to a more traditional configuration"* |
| Status | **binding.** This closes the two decisions that were blocking work (key custody, deletion policy) and extends the dropped list |
| Source | every path and line below was read out of the code at `origin/codex/ownapi-03-persistent` @ `7796cc9` on 2026-10-01 |

## 1. The four decisions, stated as acceptance criteria

### D1 — The provider is server configuration only, and is **invisible to the learner**

Today `POST /api/config` accepts `baseUrl`, `apiKey` and `model` from the browser and writes the first two into the
server's `.env`; `GET /api/config` and `/api/health` report `configured`, `model` and — until F-7 — characters of
the key. On a hosted service that is an operator control being handed to a tenant.

**Acceptance:**
1. The learner's browser cannot set, change or read the provider key, the base URL, or any part of either. Attempts
   are **refused** (`404` or `403`), not silently ignored.
2. **No route reports anything about the key** — not its length, not its presence, not a hint. Whether AI is
   available at all is either invisible or reported as a bare availability state with no key-derived field.
3. The provider key and base URL come from **server environment configuration** only
   (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`), read at startup as they are today.
4. The **Settings page contains no provider field of any kind** — no key input, no base-URL input, no "test key"
   button, no model chooser. `public/js/ai.js`'s `saveConfig`/`testKey` paths must not be reachable from the UI.
5. `SEC-01`'s origin gate and the F-7 no-key-characters rule stay enforced, and `keymask-check` and
   `server-origin-check` keep passing.

### D2 — Settings becomes a learner-preferences page

**Acceptance:** the Settings page contains only things that belong to the learner:
**language** (which language their explanations and feedback are given in — the field already exists in the
account-settings contract, and `C-06` native review is the separate human gate for the *copy*), **exam date**,
**daily goal**, and **theme**. Nothing operator-facing, nothing machine-facing.

**This makes `language` a real feature.** It is currently stored in the account-settings contract but offered
nowhere. That is its own slice: the setting, the visible control, and the rule that it actually changes which
language explanations arrive in — a stored field that changes nothing would be a defect.

### D3 — Delete is a hard delete

**Acceptance:** deleting an account or its work removes the rows; there is no soft-delete flag, no grace window, no
"disabled but retained" state, and no copy left behind by the application. What the code cannot remove — an
operator's own database backups — must be **stated plainly in the product's copy and in the record**, not implied
away. Sequence: delete the learner's rows and sessions, then anything derived (jobs, entitlements, ledger entries
that identify the learner), then confirm by reading back that they are gone.

### D4 — `start.cmd` goes, and "local-install" configuration generally goes

*"we dont need start.cmd anymore period."* `start.cmd` is the local-install launcher — double-click to run a server
on the machine. A SaaS service is started by process management, not by a file in the repository.

**Acceptance:** `start.cmd` is removed, and anything whose only purpose is the local install shape goes with it.
`README.md` and `docs/**` stop describing a local install as a supported way to run the product.

## 2. What this adds to the dropped list

Added to `SAAS-CONVERSION.md` §1.3 and `DROPPED-FOR-SAAS.md`:

| Item | Where | Why |
|---|---|---|
| **`POST /api/config` as a learner-facing route** | `server.js:697` | replaced by server configuration (D1) |
| **The key/base-URL/model fields in Settings** | `public/**` settings view, `public/js/ai.js` (`saveConfig`, `testKey`) | invisible to the learner (D1) |
| **`start.cmd`** | repository root | *"we dont need start.cmd anymore period"* (D4) |
| **Any key-presence reporting** | `GET /api/config`, `/api/health` | D1.2 — this supersedes the F-7 fix's "configured: true/false" shape, which still tells a tenant something about the operator's key |
| Soft-delete / retention-window machinery | n/a — never built | D3 chooses hard delete, so **do not build it** |

**Explicitly NOT dropped:** the **AI call path itself** (`POST /api/ai`, `/api/ai/test` as a *server-side* call),
the writing feedback feature, the objective marking, and the account settings record. The provider moves; the
feature stays.

## 3. The security consequence, stated once

Three findings in the merged record were rated Low **only because the server bound loopback and only one learner
could reach it**: F-1 (cross-origin config write), F-7 (key characters disclosed by read routes), and the F-4
severity rationale. **D1 removes the routes that caused all three**, which is a stronger outcome than re-rating
them: there is no longer a learner-reachable path to the provider configuration at all.

That does **not** close `P-03`/`X-01`. A hosted service still needs session hardening (the current session port is
synthetic, **not Better Auth**), `Secure` cookies, abuse controls, and a review of what the operator's own
infrastructure retains.

## 4. Order of work

| Step | Slice | Depends on |
|---|---|---|
| 1 | **D1** — make the provider operator-only and invisible; remove the learner-facing config surface and every key-derived field | nothing; this is the highest-value security change available |
| 2 | **D4 + the dropped-list removals** | `DROPPED-FOR-SAAS.md`; note `start.cmd` is now confirmed, and PR #59's F-5 work simplifies again — its local half is gone entirely |
| 3 | **D3** — hard delete for account and work, with a checker that reads back to prove absence | the retention question is now answered, so this is unblocked |
| 4 | **D2** — learner settings page, and `language` as a real feature | after D1, because removing the provider fields is what leaves a learner-only page |
| 5 | Re-rate the single-user-only severity claims on the record | with 1–4 done, most of them become "route removed" rather than "re-rated" |

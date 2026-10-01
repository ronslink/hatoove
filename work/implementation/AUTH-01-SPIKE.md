# AUTH-01-SPIKE — three facts before the production-auth decision

| | |
|---|---|
| Slice | MFP-03 (FUNCTIONAL-ROADMAP §5.3) — auth library vs. harden, decided by measurement |
| Base | `codex/integration-01` @ **`36163d8e0a8d8dddbfbb270eb05ddacfa7a3b172`** (printed by `git rev-parse origin/codex/integration-01`) |
| Branch | `codex/auth-01-spike` |
| Status | **COMPLETE — F1, F2 and F3 all executed, each with a verdict; recommendation below.** No production wiring, no schema migration, no root dependency, no email/OAuth, no client change |
| Environment | Linux, Node v22.23.2, npm 10.9.8, PostgreSQL 17 (local, disposable schema, synthetic data only) |
| Scratch | `/root/workspaces/authspike-scratch/` (outside the checkout; tracked tree stays clean) |
| Probes | `tools/auth-spike-*.mjs` (committed, runnable) |

**Rule observed throughout.** Every claim below is labelled **[V]** (executed here, output quoted
verbatim) or **[R]** (read in source, not executed). A negative result is reported as found.

---

## F1 — password-hash compatibility

**Question.** `server/owned-postgres/sessions.mjs:27-31` writes `scrypt:<salt-hex>:<hash-hex>`
with Node's default `scrypt`. Does Better Auth 1.7.6 verify that format, or accept a custom
`password.hash`/`password.verify` hook?

**Verdict. [V] `needs a shim`.** Better Auth 1.7.6's **default** password check is
**incompatible** with the `sessions.mjs` format — it neither verifies it nor even uses the same
parameters. The documented hook `emailAndPassword.password.verify` (and `.hash`) **is accepted
and works**: with sessions.mjs's exact scrypt code wired into that hook, sign-in succeeds, a
wrong password is still rejected, and a hook-based sign-up writes a row the hook reads back.
A shim is required, and the shim is proven working — this is **not** an obstacle to adopting
Better Auth, but it **is** a migration item: every existing `account.password` value keeps its
current format and the hook must remain for as long as any such row exists.

**Why the formats differ (read, then executed).** Better Auth's default lives in
`@better-auth/utils/dist/password.node.mjs` and is `scrypt(password, salt, dkLen=64, N=16384,
r=16, p=1)` returned as `<salt-hex>:<key-hex>` — **two** parts, `r=16`, 64-byte key, and it
NFKC-normalises the password. `sessions.mjs` uses `scryptSync(password, salt, 32)` with Node's
defaults (`r=8`, 32-byte key) and prefixes a scheme, yielding **three** parts. A default
`verify` splits on `:` and takes parts 0–1, so on `scrypt:<salt>:<hash>` it treats the literal
string `scrypt` as the salt and can never match.

**Executed.** `node tools/auth-spike-f1-hash.mjs` (Node v22.23.2, better-auth 1.7.6, pg 8.23.1,
disposable local PostgreSQL 17). The probe calls `createPostgresSessions(...).signUp(...)` —
sessions.mjs's own code — and reads the resulting `account.password`. Verbatim output:

```
=== 1. Hash produced by sessions.mjs itself ===
email                 : spike-f1@example.test
stored account.password: scrypt:4b8a81e6dea3b64cd7515d1fe5cf6934:75c79904516b5dec405300bb8a938cbc67c22bdfd41100c317eb5995b961a5a9
parts (colon-separated): 3
sessions.mjs source     : server/owned-postgres/sessions.mjs:27-31 (scryptSync, Node defaults)

=== 2. Better Auth 1.7.6 default verifyPassword(better-auth/crypto) ===
default hashPassword() example: 38bfea3f58cfeaa2e03d9bf473f2b16a:bc76ed5b43ce8060ee4fbc42a070f1e1ce0aabb0954e2101deffbbcdbf151261dcd76393cd1bb8fb89c9f423181e51c6c2e91a3f9b479046821573b2968135d0
(default hash parts          : 2 )
default verifyPassword(stored, realPassword) -> false

=== 3. Default Better Auth signInEmail (no hooks) against the sessions.mjs hash ===
default sign-in -> {"ok":false,"status":"UNAUTHORIZED","body":{"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}}

=== 4. Same instance with emailAndPassword.password.{hash,verify} = sessions.mjs scrypt ===
shim sign-in (real password) -> {"ok":true,"token":true,"keys":["redirect","token","url","user"]}

=== 5. Discrimination ===
shim sign-in (wrong password) -> {"ok":false,"status":"UNAUTHORIZED","code":"INVALID_EMAIL_OR_PASSWORD"}
shim sign-up wrote          : scrypt:a8895b031f7ac02446a4b1eb3dc0cdfb:89972afdfe5cc6889964077ebb1b496b90789b652f0bd206400153568a8b9f02
that is sessions.mjs shape  : true
shim sign-in on shim row ok : true

=== VERDICT (F1) ===
default-compatible : NO
shim-possible      : YES (emailAndPassword.password.verify)
```

**The exact shim** (the hook Better Auth reads at `dist/context/create-context.mjs:183-184`;
verified working above):

```js
emailAndPassword: {
  enabled: true,
  minPasswordLength: 12,
  password: {
    hash: (password) => {                       // writes the SAME format sessions.mjs writes
      const salt = randomBytes(16);
      return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
    },
    verify: ({ hash, password }) => {           // reads sessions.mjs rows unchanged
      const [scheme, saltHex, hashHex] = String(hash || '').split(':');
      if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
      const expected = Buffer.from(hashHex, 'hex');
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  },
}
```

**What this means if accounts exist** (see F3): the shim is only needed while real
`account.password` rows exist. If F3 finds only synthetic rows, adopting Better Auth needs **no**
shim at all and new accounts get Better Auth's own format. If real accounts exist, the shim above
is the whole migration — `account.password` is never rewritten, so no row breaks.

**What was executed vs. read.** Executed: the four sign-in/sign-up paths and both verify calls
above, end to end, against a real database. Read only (not executed): the parameter values
`r=16, dkLen=64, NFKC` in `@better-auth/utils/dist/password.node.mjs`, and the hook wiring in
`dist/context/create-context.mjs:183-184` — the probe exercises that wiring's *effect*, not the
file itself.

---

## F2 — mount on bare `node:http`, behind the origin gate, with database-backed rate limiting

**Verdict. [V] `mounts, and all three requirements are met`.**

- **It mounts on a bare `node:http` server.** `toNodeHandler(auth)` (the `better-auth/node`
adapter) dispatches `POST /api/auth/sign-in/email` from inside `http.createServer`, and it sits
**behind** a stand-in for the SEC-01 `isSameOriginRequest` gate: a foreign `Origin` is refused
**before** the library is reached (403), a same-origin request reaches it (200).
- **Rate limiting can live in the database.** With `rateLimit: { enabled: true, storage:
'database' }` the library **creates its own `rateLimit` table** via `getMigrations`, the counter is
visible in that table, and a **second, independent instance over the same database refused a
request it had never counted in its own memory (429)** — which is only possible if the counter is
in the database. This is exactly the property memory-backed limiting fails on a multi-instance
service.
- **Cookie flags: `HttpOnly` yes, `SameSite=Lax` yes, `Secure` host-decided and configurable.**
Over an `http` origin the session cookie is `HttpOnly; SameSite=Lax` with **no `Secure`** (correct
for loopback); setting `advanced.useSecureCookies: true` adds `Secure` **and** the `__Secure-`
name prefix on the same http origin. So the plan's `Secure`-in-hosted requirement is a config
switch, not a build.

**Executed.** `node tools/auth-spike-f2-mount.mjs`. Verbatim output:

```
=== A. Library-created schema with rateLimit.storage="database" ===
tables now present: account, rateLimit, session, user, verification
rateLimit table present: true
node:http server listening on http://127.0.0.1:41533

=== B. Mount proof — same-origin request reaches the library, foreign origin does not ===
POST /api/auth/sign-in/email  Origin: http://evil.example -> 403 {"error":"forbidden_origin"}
POST /api/auth/sign-in/email  Origin: http://127.0.0.1:41533 -> 200
Set-Cookie: ["better-auth.session_token=L0rGo0vAeFbUmgp5nhD3W58rdjSi9Mnc.dLQEmy5UixN4eJo2%2B1%2FuQOdd9fDeZyvxQISLgK43tCo%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"]

=== C. Rate limit is DATABASE-backed (not memory) ===
4 same-origin sign-ins on one bucket in one window -> statuses [200,200,200,429] (expect 200,200,200,429)
rateLimit rows in the database: [{"key":"203.0.113.7|/sign-in/email","count":1},{"key":"198.51.100.9|/sign-in/email","count":3}]
a SECOND instance (empty memory, same DB) sign-in -> 429 (429 proves the counter is in the database)

=== D. Cookie flags and their configurability ===
default (http) session cookie: better-auth.session_token=L0rGo0vAeFbUmgp5nhD3W58rdjSi9Mnc.dLQEmy5UixN4eJo2%2B1%2FuQOdd9fDeZyvxQISLgK43tCo%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
  host decided Secure via baseURL http         -> false
  HttpOnly                                     -> true
  SameSite                                     -> Lax
advanced.useSecureCookies:true over the SAME http origin:
  cookie: __Secure-better-auth.session_token=Xm2fKW5xzdBcLORYLJza60NuBb0LD56F.%2FNp%2FK3ZxHrFyjACewiz2hbaLuvBuavF6wsE4GSjQV7o%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
  __Secure- name prefix -> true | Secure flag -> true

=== VERDICT (F2) ===
mounts on bare node:http : YES (same-origin 200, foreign 403)
db-backed rate limiting  : YES (rateLimit table + cross-instance 429)
Secure over http         : host-decided, NOT set (correct over http); settable with useSecureCookies
HttpOnly                 : YES
SameSite                 : Lax
```

**Two limits on the rate limiter, found by reading the source (not executed):**

1. **It is per-IP per-path, not per-account.** `createRateLimitKey(ip, path)`
(`@better-auth/core/dist/utils/ip.mjs`) yields `"<ip>|<path>"` — visible above as
`"198.51.100.9|/sign-in/email"`. There is therefore **no built-in per-account throttle**; an
attacker spraying one known account from many IPs is not slowed. Per-account throttling needs
`rateLimit.customRules` plus a custom storage, or an application-level counter.
2. **The special sign-in/sign-up rule is `window 10s, max 3`**
(`dist/api/rate-limiter/index.mjs:302-313`). The custom `window:60, max:100` becomes the default
for other paths; the auth paths keep the stricter 3-per-10s. This is what produced the 429 above.

**`__Host-` is defined but never applied.** The library exports `HOST_COOKIE_PREFIX = "__Host-"`
and strips such a prefix when *reading* a cookie, but `createCookieGetter` only ever prepends
`__Secure-`. So the roadmap's J1 `Secure`/`__Host-` ambition is reachable only by naming the
cookie yourself (`advanced.cookies.session_token.name`); with `Path=/` and no `Domain` the
browser accepts that. Recorded as a configuration item, not a blocker.

---

## F3 — how many real accounts exist on any persistent installation

**Verdict. [V] `zero, as far as any evidence in this repository or on this host shows`.** Every
account-creation site in the tracked tree is a **checker**, every address used is **synthetic**, and
every installation the records describe is **disposable**. **This materially simplifies F1: with no
real `account.password` rows to preserve, adopting Better Auth needs no compatibility shim at all.**

**Established by** `node tools/auth-spike-f3-accounts.mjs`. Verbatim (tail):

```
files scanned: 264

=== 2. Every email literal, classified ===
synthetic  'alice@example.test   (spikes/auth-runtime/isolation.test.mjs:51)
synthetic  'bob@example.test   (spikes/auth-runtime/isolation.test.mjs:51)
synthetic  'synthetic.account-ui@example.invalid   (tools/account-ui-browser-check.mjs:47)
synthetic  'x@accounts.example.invalid   (tools/accounts-http-check.mjs:146)
... (22 distinct literals, all listed by the probe) ...
synthetic  'a@pg.example.invalid   (tools/owned-api-pg-check.mjs:108)
synthetic  'learner@example.com   (tools/owned-client-check.mjs:82)
synthetic  'ron@example.com   (tools/owned-client-check.mjs:188)

synthetic: 22   real-looking: 0

=== 3. What the records say about the installations those writers ran against ===
work/implementation/OWNAPI-03.md
  | ## Evidence — executed against real PostgreSQL 17 (disposable container, synthetic rows)
work/implementation/COORD-REEXECUTION-e126d8c.md
  | | Database | a **fresh disposable** database `hatoove_rev` on a labelled disposable container (`postgres:17-alpine`), synthetic accounts only. **No production access of any kind** |
work/implementation/CONFIG-ANON-01.md
  | | Method | ... a throwaway `B1PREP_ENV_FILE`, a disposable PostgreSQL database ... Synthetic data only |

=== VERDICT (F3) ===
account-creation sites   : 79
real-looking emails      : 0
=> every writer that exists is a checker; every address is synthetic.
```

The probe counts **79 account-creation sites in code** (`tools/` 68, `spikes/` 3, `server/` 3,
`server/owned-postgres/` 3, `public/js/` 2). Every one is either a checker (`tools/**`, `spikes/**`)
or a code path *reached by* a checker: the owned-API route (`owned-api.mjs:271`) calls
`sessions.mjs:111`'s `signUp`, and the client's own call (`public/js/account.js:668` →
`owned-client.js:90`) needs that same mounted server. `server.js`'s owned-API mount is a recent A-01
change and **no deployment of any of it exists**. The one `ron@example.com` literal is a **synthetic
test fixture** in `owned-client-check.mjs`, not a person.

**Four independent lines of evidence agree:**

1. **No real address exists in the tree.** 22 distinct email literals, **0** real-looking; a broader
   grep for ordinary `@gmail.com`-style addresses across `*.mjs/*.js/*.json/*.md` returns **nothing**.
2. **Every described installation is disposable.** `OWNAPI-03` proved persistence against a
   "disposable container, synthetic rows"; `COORD-REEXECUTION-e126d8c` against a "fresh disposable
   database"; `DECISION-saas-runtime-merge` against "a fresh disposable `postgres:17-alpine`".
3. **CI's database is ephemeral.** `.github/workflows/ci.yml:101-129` runs a `postgres:17-alpine`
   **service container** (`OWNAPI_PG_DATABASE: hatoove_ci`) that is destroyed with the job.
4. **This host holds none.** On this machine's local PostgreSQL there is **no** `hatoove`/`ownapi`
   schema and no application `"user"` table; the only `public."user"` is the disposable
   `authspike_spike` database these probes created. (Queried: `pg_namespace` where `nspname like
   '%hatoove%' or '%ownapi%'` → `[]`.)

**The one installation that is *not* disposable is `D:\B1_Prep`** — Ron's live single-user copy on
Windows. It predates the owned API, keeps no `account` rows (its persistence is `progress.json` plus
a `localStorage` blob, `AUTH-USER-AUDIT.md` §1), and this programme is forbidden to touch it. So it
cannot hold Better Auth credential rows, and no evidence contradicts "zero".

**How confident, and the limit.** Confident that **no real account exists in this repository's
history, in CI, or on this host.** I **cannot** see every installation: I cannot read `D:\B1_Prep`, any
operator's workstation, any cloud droplet, or CI secrets, and there is no fleet-wide inventory to
read. The claim is therefore "zero on every installation there is evidence for", not "zero in the
universe". If Ron knows of a running install with real sign-ups, that single fact re-opens F1's
consequence — and the shim above is already proven, so even then the migration is one hook.

---

## Addendum — what Better Auth would change in the production schema

Not asked for directly, but it decides the "schema" consequence, so it was measured.
`node tools/auth-spike-schema-diff.mjs`, against a database holding **exactly** the production shape
(`spikes/auth-runtime/auth-schema.sql` = migration `0001`):

```
=== 1. tables BEFORE (the production shape, migration 0001) ===
account, session, user, verification

=== 2. Better Auth compileMigrations() with rateLimit.storage="database" ===
create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

=== 3. compileMigrations() with the DEFAULT (memory) rate limiter ===
;

=== 4. run the database-storage migrations, then list tables AFTER ===
account, rateLimit, session, user, verification
```

**So adoption adds at most ONE table and alters nothing.** With database rate limiting it emits a
single `create table "rateLimit"`; with the default memory limiter it emits **no SQL at all**. It
issues **no `ALTER`** against `user`, `session`, `account` or `verification`, so **no existing session
or account row breaks** — a statement now backed by execution, not by hope.

---

## Recommendation (conditional on F1–F3)

**Adopt Better Auth 1.7.6 over the existing tables.** The recommendation is a consequence of the
three measurements, not a preference:

- **F1 says the one real risk is surmountable, and F3 says we do not even need to surmount it.** The
default password check is incompatible, but the hook is proven, and **no real `account.password` row
exists to preserve** — so adoption needs **no shim today**; if a real account ever appears, the already
executed hook covers it without rewriting a single row.
- **F2 says the three integration requirements are all met, two of them for free.** It mounts on bare
  `node:http` behind the origin gate; the rate limit is genuinely database-backed across instances;
  the cookie is `HttpOnly` + `SameSite=Lax`, with `Secure` a config switch.
- **The schema is already the library's shape.** Adoption is **at most one additive table** and issues
  no `ALTER` — so no session or account row breaks, and migration `0001` stops being a coincidence and
  becomes the asset the roadmap called it.

**Hardening `sessions.mjs` is the fallback, not the default.** It is a defensible choice only if the
"root app is dependency-free" property is worth more than the ~8 capabilities below, all of which would
have to be written and each of which is easy to get subtly wrong.

### Consequences — dependencies

**The root `package.json` does not have to change.** Better Auth belongs in
`server/owned-postgres/package.json`, whose description already says it exists *"so the root app stays
dependency-free"* and which already carries `pg`. Adoption therefore **enlarges an already-dependent
server scope, not the root app** — CI today already runs `npm ci --prefix server/owned-postgres`
(`ci.yml:139`). The honest cost, measured in the scratch tree:

| | |
|---|---|
| added top-level packages | 28 (total tree), incl. `zod`, `kysely`, `jose`, `@noble/*`, `nanostores` |
| installed size | ~35 MB of `node_modules` |
| install time | ~24 s (`added 37 packages in 24s`, better-auth + pg) |
| lockfile | `server/owned-postgres/package-lock.json` grows |
| Node floor | root says `>=20`; the spike pins `>=22.16` — the **server scope's** floor rises to 22.16 (this host runs 22.23.2) |
| CI time | the scope already installs; the delta is the install itself |

**The caveat, stated plainly:** the property survives *only because the dependency is scoped*. If the
runtime is ever expected to run from a single root install, the property ends. It should be a conscious
decision, not an accident.

### Consequences — schema

**One additive migration, and only if database rate limiting is chosen.** Executed evidence (addendum
above): against the production shape the compiler emits exactly `create table "rateLimit" (...)`, or
`;` (nothing) with the memory limiter. **No `ALTER`, no existing session or account row breaks.** If a
compatibility shim for real hashes is ever needed, it changes only application code, not the schema.

### Consequences — capability by capability

| Capability | Adopt Better Auth | Harden `sessions.mjs` |
|---|---|---|
| `Secure` cookie | **config** (`advanced.useSecureCookies`, or an https `baseURL` decides it) | **build** |
| `HttpOnly` + `SameSite` | **free** (`HttpOnly; SameSite=Lax` observed) | **build** |
| Session expiry, sliding | **free** (`updateAge`) | build |
| **Session token rotation** | **build** — refresh re-issues the same token (`session.mjs:199`) | build |
| Revocation on password change | **config** (`revokeOtherSessions: true`; `revokeSessionsOnPasswordReset`) | build |
| Password reset | **free API + email decision** (`requestPasswordReset`/`resetPassword`) | build |
| Email verification | **free API + email decision** (`sendVerificationEmail`) | build |
| Enumeration-safe **sign-in** | **free** (generic `INVALID_EMAIL_OR_PASSWORD` observed) | build |
| Enumeration-safe **sign-up** | **config** (`requireEmailVerification` or `autoSignIn:false`; otherwise `USER_ALREADY_EXISTS` leaks) | build |
| Per-IP throttling | **free**, database-backed (proven) | build |
| **Per-account throttling** | **build** — library key is `ip|path` (`@better-auth/core/utils/ip.mjs`) | build |
| **Session sweep** | **build** — expired rows are deleted lazily when presented (`session.mjs:158-166`); no background sweep | build |
| Revoke-all-sessions | **free** (`revokeSessions`) | build |

**Reading the table:** adoption turns ~8 of 13 capabilities from *build-and-might-get-it-wrong* into
**free or configuration**. The three that remain build-yourself (rotation, per-account throttle, sweep)
are also build-yourself under hardening — so adoption is **strictly less work**, and the things left to
build are the small, well-understood ones.

**One `__Host-` note.** The library defines `HOST_COOKIE_PREFIX = "__Host-"` but never applies it — it
only prepends `__Secure-`. If the plan wants `__Host-`, name the cookie explicitly via
`advanced.cookies.session_token.name`; with `Path=/` and no `Domain` that is valid.

### Consequences — the sign-up gate

**Recommendation: invite-only for the pilot.**

Fail-closed is already right (the runtime refuses learner routes until accounts load), **but "closed to
un-ready" is not "closed to strangers"**: `POST /api/auth/sign-up/email` (`owned-api.mjs:270-274`) has
**no email verification, no invite check and no throttle**, and `POST /api/ai` (`server.js:977`) is
session-gated **but unmetered** — a grep finds **no rate limiting anywhere in the server** (the only
`429` in `server.js` is a mapping of an *upstream* code). Open sign-up therefore gives any stranger
**unlimited use of the operator's provider key and budget** — the highest-value abuse in the product.

- **Open** is only safe once sign-up has verification + throttling *and* `/api/ai` is metered or deleted.
- **Invite-only** is the right pilot gate: the pilot is free with a configured allowance, so invites are
  enough, and the client already models an invite on the sign-up form. It converts an unbounded cost
  risk into a bounded one.
- **Waitlist-gated** adds a marketing step without changing the security picture; choose it only if
demand is expected to exceed invites.

### Consequences — email (a decision, not a provider)

No provider is chosen here. The decision email **forces** is: **which data processor may receive
learners' email addresses, verification links and reset tokens, in which region, under which DPA** —
because those are personal data, which is why this touches **`P-03`**. That decision in turn determines:
(a) the processor terms and sub-processors; (b) the sending-domain DNS work (SPF/DKIM/DMARC on the
sending domain — a DNS change, therefore Ron's); (c) the token TTL the provider's latency allows; and
(d) whether `check-email` is a **hard gate** (verification required before use) or a soft prompt.

### What this recommendation does NOT authorize

No production wiring, no dependency added, no migration applied, no email provider, no OAuth/Google
credentials, no client change, no `D:\B1_Prep`. `Secure`-cookie/rotation/recovery work is `MFP-04a`,
after the decision.

---

## The three questions for Ron

1. **Do we adopt Better Auth over the existing tables, or harden `sessions.mjs` ourselves?**
   *(Recommend: adopt — F1/F2/F3 all favour it, and it is strictly less work.)*
2. **For the pilot, is sign-up open, invite-only, or waitlist-gated?**
   *(Recommend: invite-only — open sign-up today is an unmetered key to your provider budget.)*
3. **Which email provider may hold learners' addresses, verification links and reset tokens, and in
   which region?** *(This is `P-03`; no provider is chosen here — your answer sets the processor, the
   DNS work and whether `check-email` is a hard gate.)*

---

## LIMITS

**Executed (not read):** F1's four sign-in/sign-up paths and both verify calls; F2's mount, 403/200
gate, database rate-limit rows, cross-instance 429, and both cookie variants; F3's tree walk; the schema
diff's `compileMigrations()` output and `runMigrations()`. All against better-auth **1.7.6** and
pg **8.23.1** on Node v22.23.2, with PostgreSQL 17.

**Read, not executed — could be wrong:**

- The **absence of session-token rotation** and of a **background session sweep** is a reading of
  `dist/api/routes/session.mjs` and `update-session.mjs`, not a probe. A probe that forces expiry would
  be the confirmation.
- The **per-account-throttling gap** is a reading of `createRateLimitKey(ip, path)`; I did not attempt
  to make the library throttle one account.
- The **enumeration-safe sign-up** configuration (`requireEmailVerification` / `autoSignIn:false`) is a
  reading of `sign-up.mjs:158-205`; I did not execute a duplicate-sign-up.
- The **DDL parameter values** (`r=16, dkLen=64, NFKC`) are a reading of
  `@better-auth/utils/dist/password.node.mjs`; the probe proves the *effect* (mismatch), not those
  literals.
- Better Auth's behaviour for **email verification, reset and OAuth** was read, not run — none of those
  paths was configured (by instruction).

**Could not test at all:**

- **A `Secure` cookie over TLS.** There is no TLS endpoint here; I proved the *attribute* is settable
  over an http origin and that `baseURL` scheme decides it, but the browser-acceptance path over HTTPS
  (and `__Host-` semantics) is untested.
- **A genuine second instance.** "Cross-instance" was two Better Auth objects in **one process** sharing
  one database — which is sufficient to show the counter is not per-instance memory, but it is **not**
  two hosts, a load balancer, or a real multi-instance deployment.
- **Real email delivery**, **OAuth**, **a live model provider** — all deliberately unconfigured.
- **The live installation and any installation I cannot see.** `D:\B1_Prep` is off-limits and unread; I
  cannot enumerate a fleet. F3's zero is "zero on every installation there is evidence for".
- **Rendered/browser behaviour.** No browser was used; nothing here is a UI or device claim.
- **Anything version-specific.** All results are for **better-auth 1.7.6** as pinned; a later release may
  change the default hash, the cookie prefix, or the limiter's key shape.

**Reproducibility.** The probes import `better-auth`/`pg` from an installed tree **outside** the checkout
(`AUTHSPIKE_DEPS`, default `/root/workspaces/authspike-scratch`), so the tracked tree stays clean and the
root app stays dependency-free. `spikes/auth-runtime/package-lock.json` pins the same tree if a reviewer
prefers `npm ci` there.

# AUTH-01-SPIKE — three facts before the production-auth decision

| | |
|---|---|
| Slice | MFP-03 (FUNCTIONAL-ROADMAP §5.3) — auth library vs. harden, decided by measurement |
| Base | `codex/integration-01` @ **`36163d8e0a8d8dddbfbb270eb05ddacfa7a3b172`** (printed by `git rev-parse origin/codex/integration-01`) |
| Branch | `codex/auth-01-spike` |
| Status | **IN PROGRESS — skeleton committed before the first probe** |
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

**Verdict.** _pending_

**Executed.** _pending_

---

## F3 — how many real accounts exist on any persistent installation

**Verdict.** _pending_

**Established by.** _pending_

---

## Recommendation (conditional on F1–F3)

_pending_

---

## The three questions for Ron

_pending_

---

## LIMITS

_pending_

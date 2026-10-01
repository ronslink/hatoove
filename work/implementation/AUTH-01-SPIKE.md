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

**Verdict.** _pending_

**Executed.** _pending_

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

# SAAS-RUNTIME-01 — the runtime boundary fails closed (issue #63 step A)

| | |
|---|---|
| Task | `SAAS-RUNTIME-01` (issue #63, step A) |
| Worker | OpenClaw/Hetzner, execution `saas-runtime-01-openclaw-20261001-b` (attempt 2) |
| Coordinator | `COORD-TAKEOVER-20260930` |
| Branch | `codex/saas-runtime-01` |
| Base | `origin/codex/ownapi-03-persistent` @ `90d9860` |
| Authority | [issue #63](https://github.com/ronslink/hatoove/issues/63); `HOSTED-BLOCKERS.md` (S1/S2 = B5/B6); `SERVER-READINESS.md` (B2 withdrawn) |
| Status | in progress — this file is **append-only**; do not edit the issue-63 records |

This record is written as the work proceeds. Attempt 1 (`...-a`) produced changes that were never run,
never committed and never pushed; that work was archived unverified and is **not** a starting point.

## Scope (from the brief)

Three refusals plus one configuration change:

- **A1** — the legacy progress routes (`x-b1prep-account` owner selector and the unscoped fallback) must be
  unavailable in the hosted runtime; the local-install path survives only behind an explicit, off-by-default flag.
- **A2** — `/api/ai` and `/api/ai/test` require a verified session; the caller's `model` is ignored; input is
  bounded server-side.
- **A3** — a SaaS startup mode fails closed on missing/failed auth or database: learner routes 503, readiness
  false, never a downgrade to anonymous single-user.
- **A4** — the trusted origin is configuration (the deployment's exact public origin); the allowed origin is
  accepted and a foreign origin is still refused.

## Checkpoints

- [ ] A1 refusal + discrimination + push
- [ ] A2 refusal + discrimination + push
- [ ] A3 fail-closed + discrimination + push
- [ ] A4 configured origin + discrimination + push
- [ ] `tools/saas-runtime-check.mjs` green
- [ ] baseline counts unchanged; `repository-check.mjs` passes
- [ ] draft PR opened

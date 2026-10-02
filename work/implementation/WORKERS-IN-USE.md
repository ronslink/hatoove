# WORKERS IN USE — read this before dispatching

**Clawdbot is NOT in use.** Ron, 2026-10-01: *"we are not using clawbot."* Do not dispatch to it, do not count it
in the roster, and do not cite its outputs as evidence.

| Worker | Where | Notes |
|---|---|---|
| Coordinator | local | verification, integration, architecture, records |
| **OpenClaw** | Hetzner (`ssh hetzner`) | implementation **and push**; has Docker and PostgreSQL. `openclaw agent exec` has **no `--timeout`** flag |
| **Hermes** | Docker `hermes-agent` | implementation and verification; **cannot push**, cannot reach GitHub, gets **no PostgreSQL work** |
| **Claude** | local Windows | preferred for complex tasks **when it has quota**; needs `--allowedTools` or it silently loses Bash/Write |

Reviewer order, now that the roster is smaller: **Hermes** first, then **Claude** when it has quota, then a
delegated reviewer under the coordinator (recorded as a deviation, and never for a slice the coordinator authored).
A reviewer must never be the author of the slice under review.
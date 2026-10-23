# IndexNow hardening — deployment gate and prepared ingress activation

Status: **prepared, not merged, not deployed**. Production remains at `f4f1d3e38d0d1a5fbcb3a88ebe4f688bcbebc8e8`; no application code, ingress configuration, DNS or learner data was changed by this slice. The live verification and submission recorded in [INDEXNOW-20261021.md](INDEXNOW-20261021.md) remain the latest production evidence.

Execution: `INDEXNOW-HARDENING-20261023-A`. Base: `f4f1d3e38d0d1a5fbcb3a88ebe4f688bcbebc8e8`. Branch: `codex/indexnow-hardening-20261023`. Isolated worktree: `.worktrees/indexnow-hardening-20261023`. Ron approved both follow-ups on 23 October 2026 after the live re-verification: a deployment-time key check and a prepared ingress-reload step. Neither approval authorizes merging (which auto-deploys) or activating ingress.

## Changes

1. `.github/workflows/deploy.yml` — the post-deployment verification step now fetches the ownership file and requires HTTP 200, a `text/plain` content type and a body equal to the exact key. Previously only unrelated route status codes were checked, so a lost or altered key file could deploy with a green job. A failure here is an alert after the release, not an automatic rollback.
2. `deploy/activate-ingress.sh` — new reviewed activation step for the Caddy fallback already present in `deploy/Caddyfile`. `--check` is read-only: it proves production host, deployment lock, staged `.reviewed-commit`, exact Caddyfile SHA256, ingress compose project and pinned image, runs a local Caddy validation with that image, probes the currently served key and public contract, then prints the plan without restarting or writing. `--apply` restarts only the ingress container with `--no-deps`, then requires key body/type, suffixed-path refusal, foreign-host 421, HTTP 308, `/api/ready` 200, the reviewed Caddyfile hash inside the container, unchanged app/worker/database identities, unchanged ingress image and unchanged source marker. On failure it restores the previously served configuration byte-for-byte from the container, restarts only ingress, verifies readiness, and otherwise reports `RECOVERY REQUIRED` while preserving the running process. Evidence is retained under `/opt/hatoove/ops/indexnow/<timestamp>`. It never runs migrations, recreates app/worker, or touches volumes.
3. `docs/INDEXNOW.md` — documents the deployment gate and the two activation modes, including the separate-authorization boundary.
4. `tools/indexnow-check.mjs` — two contract legs assert that the deployment gate checks the key body and type, and that the activation script stays read-only by default, ingress-only, lock/host/hash gated and rollback aware. Negative assertions reject any future command that would deploy, recreate, migrate or remove volumes through this script.

## Evidence

- `node --test tools/indexnow-check.mjs`: **13/13 pass** (11 existing + 2 new contract legs).
- `node tools/production-compose-check.mjs`: pass, 4 source groups / 11 mutations.
- `node tools/repository-check.mjs` on the staged snapshot: pass, 852 tracked files / 753 text blobs.
- `bash -n deploy/activate-ingress.sh` via Git Bash: pass.
- No live check was re-run for this slice and no live submission was made; the canonical dirty checkout was not modified.

## Limits and risks

- The activation script is statically tested, not executed against production. Its first real use requires fresh inspection of the host, `.reviewed-commit`, Caddyfile hash, ingress image and container identities, plus Ron's explicit authorization.
- A failed deployment-gate check does not roll back a release; it marks the deploy job red after the fact.
- Until authorized, the Caddy `respond` fallback remains unloaded and the Node static route serves the key, exactly as recorded on 23 October.
- If `--apply` rolls back, the staged `/opt/hatoove/src/deploy/Caddyfile` is left holding the previously served bytes; the next application deployment replaces the staged source again.

## Next action

Independent review of the exact committed branch, then Ron's decision on merging (which triggers the automatic production deployment of main) and, separately, on running the ingress activation.

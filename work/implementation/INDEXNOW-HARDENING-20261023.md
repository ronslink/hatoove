# IndexNow hardening — deployment gate and prepared ingress activation

Status: **prepared, not merged, not deployed**. Production remains at `f4f1d3e38d0d1a5fbcb3a88ebe4f688bcbebc8e8`; no application code, ingress configuration, DNS or learner data was changed by this slice. The 23 October live re-verification (key HTTP 200 with the exact body and `text/plain`, the two sitemap URLs, and a fresh submission answered HTTP 200, resolving the 21 October HTTP 202) was performed from the canonical checkout and is not part of this branch. The branch copy of `INDEXNOW-20261021.md` predates that post-deployment receipt and must not be read as the latest production evidence.

Execution: `INDEXNOW-HARDENING-20261023-A`. Base: `f4f1d3e38d0d1a5fbcb3a88ebe4f688bcbebc8e8`. Branch: `codex/indexnow-hardening-20261023`. Isolated worktree: `.worktrees/indexnow-hardening-20261023`. Pull request: [#180](https://github.com/ronslink/hatoove/pull/180), unmerged. Ron approved both follow-ups on 23 October 2026 after the live re-verification: a deployment-time key check and a prepared ingress-reload step. Neither approval authorizes merging (which auto-deploys) or activating ingress.

## Changes

1. `.github/workflows/deploy.yml` — the post-deployment verification step now fetches the ownership file and requires HTTP 200, a `text/plain` content type and a body equal to the exact key. Previously only unrelated route status codes were checked, so a lost or altered key file could deploy with a green job. A failure here is an alert after the release, not an automatic rollback.
2. `deploy/activate-ingress.sh` — new activation step for the Caddy fallback already present in `deploy/Caddyfile`. The activation discriminator is the Caddyfile hash the ingress has **loaded** (read from the container), not the public key response: the Node route already answers the key, so a 200 key response does not prove the fallback is active.
   - `--check` proves the production host, deployment lock, staged `.reviewed-commit`, exact Caddyfile SHA256, the reviewed ownership directive, the running ingress image against `HATOVE_CADDY_IMAGE`, the loaded Caddyfile hash and a local Caddy validation with the running image. It prints "already active" only when the loaded hash equals the reviewed hash and the public contract passes; otherwise it prints the restart plan. It does not modify the Caddyfile or restart ingress; it does take the deployment lock and create a temporary probe directory.
   - `--apply` requires the loaded hash to differ, restarts only the ingress container with `--no-deps`, then requires loaded hash equality with the reviewed Caddyfile, key body/type, suffixed-path refusal, foreign-host 421, HTTP 308, `/api/ready` 200, unchanged app/worker/database identities, unchanged ingress image and unchanged source marker. The key, suffix, foreign-host and redirect probes are defence in depth, not proof that the ingress response replaced the Node route.
   - On failure it restores the previously served configuration byte-for-byte from the container, re-validates and restarts only ingress, verifies readiness, and otherwise reports `RECOVERY REQUIRED` while preserving the running process. A rollback leaves the staged Caddyfile at the previously served bytes until the next deployment replaces it.
   - Evidence is retained under `/opt/hatoove/ops/indexnow/<timestamp>`. It never runs migrations, recreates app/worker, or touches volumes.
3. `docs/INDEXNOW.md` — documents the deployment gate, the loaded-configuration discriminator and the separate-authorization boundary.
4. `tools/indexnow-check.mjs` — two contract legs assert that the deployment gate checks the key body and type **after** the deploy step, and that the activation script inspects the loaded Caddyfile before restarting, uses the loaded hash rather than the key response as its discriminator, and rejects direct deployment, migration, recreate and volume commands. Comments are stripped before matching and the checks are structural where possible; they guard against direct regressions, not deliberate obfuscation.

## Independent review

Independent review R1 (`80dfb0a`, before the fix) returned **CHANGES REQUIRED**. The blocking finding was correct: the first version short-circuited on the public key response, which the Node route satisfies, so `--apply` would have exited 0 without ever restarting ingress. Findings I1–I4 and M1–M6 were also reviewed and addressed: docs overclaims, stale repository-guard counts, substring-only tests, misleading activation evidence, signal trap statuses, staged-source rollback, host-side hashing, running-image comparison and the host/TLS assumptions recorded below. The delta re-review of the follow-up commit is requested separately and is not claimed in this commit.

## Evidence

- `node --test tools/indexnow-check.mjs`: **13/13 pass** (11 existing + 2 new contract legs).
- `node tools/production-compose-check.mjs`: pass, 4 source groups / 11 mutations.
- `node tools/repository-check.mjs` from the worktree on the final staged snapshot: pass, **854 tracked files / 755 text blobs**.
- `node tools/seo-check.mjs`: 11/11 pass. `node tools/retired-surface-check.mjs`: 10 passed.
- `bash -n deploy/activate-ingress.sh` via Git Bash: pass.
- `.github/workflows/deploy.yml` parsed as YAML and its verification step body passed `bash -n`; the step is the last job step, after the deploy step.
- Read-only live probes confirmed production unchanged: key HTTP 200 with the exact body, `/api/ready` 200, HTTP 308 redirect, suffixed path refused. No live submission was made for this slice; the canonical dirty checkout was not modified.

## Limits and risks

- The activation script is statically tested, not executed against production. Its first real use requires fresh inspection of the host, `.reviewed-commit`, Caddyfile hash, ingress image and container identities, plus Ron's explicit authorization.
- `production_host=hatoove-app-01` is a repository constant that could not be verified against the droplet in this environment; a wrong value fails closed before any mutation.
- The local probes and the rollback readiness check assume origin TLS validates against the host CA bundle. A Cloudflare Origin CA certificate would make them fail and could produce a false `RECOVERY REQUIRED`.
- The loaded-configuration discriminator assumes the deployment replaces the bind-mount file with a new inode without restarting ingress, which is what `deploy-release.sh` does. An in-place edit of the mounted file while the ingress is running could make the loaded hash look current before Caddy has reloaded.
- The loaded hash comparison uses `HATOVE_CADDY_IMAGE` only when that variable is present in the production environment file.
- A failed deployment-gate check does not roll back a release; it marks the deploy job red after the fact.
- Until authorized, the Caddy `respond` fallback remains unloaded and the Node static route serves the key.

## Next action

Independent delta review of the fixed commit; then Ron's decision on merging (which triggers the automatic production deployment of main) and, separately, on running the ingress activation with a freshly inspected commit and Caddyfile hash.

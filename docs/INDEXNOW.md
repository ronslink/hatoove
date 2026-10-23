# IndexNow

The public ownership key is `16a91221eb78411198dbd6254bf9e653`. It is deliberately public and is not a credential. The matching UTF-8 file lives in `public/` and its exact resolved path is allowed through the Node session gate. The supplied Caddy configuration also serves the exact key path, allowing activation through ingress while preserving the existing application image. Every other request keeps its existing routing. Once that Caddy configuration is loaded, its key response remains available if the application is offline.

```sh
npm run indexnow -- --check
npm run indexnow -- --dry-run
npm run indexnow
npm run indexnow -- /telc-deutsch-b1
npm run check:indexnow
```

The script requires Node.js 20 or later. Without paths, it reads the live flat sitemap at `https://hatoove.com/sitemap.xml`; sitemap indexes are explicitly rejected. It validates canonical same-origin HTTPS URLs, deduplicates them, verifies the live key without redirects, then sends batches of at most 10,000 URLs to `https://api.indexnow.org/indexnow`. Participating engines share submissions. Dry-run and check-only modes never submit URLs. No build or startup automatically submits URLs.

HTTP 200 means submitted; HTTP 202 means received with key validation pending. Neither guarantees indexing. HTTP 403 indicates an unavailable or invalid key, 422 a host/key scope mismatch, and 429 a rate limit. Failures exit nonzero.

Before deployment, compare the release with the latest verified production revision. When the difference contains only the approved IndexNow changes, the existing production pipeline can publish the Node ownership file after the required checks pass. That pipeline rebuilds and restarts app/worker and retains a database backup and existing volumes; it does not reload ingress, so do not claim that the Caddy response is active from a successful application deployment alone. Verify the exact public key body, a nonmatching path, retained headers, canonical HTTP redirect and application health before submitting URLs.

The deployment workflow now verifies the live ownership response itself after every release: HTTP 200, a `text/plain` content type and a body equal to the exact key, not only a status code. A failure turns the deploy job red after the release has already happened, so it is an alert rather than an automatic rollback.

The prepared `deploy/activate-ingress.sh` step would load the already staged Caddyfile delta by restarting only ingress. It is dry-run by default and requires the fresh reviewed commit and Caddyfile SHA256:

```sh
deploy/activate-ingress.sh --check <reviewed-commit> <caddyfile-sha256>   # read-only preflight and plan
deploy/activate-ingress.sh --apply <reviewed-commit> <caddyfile-sha256>   # only with explicit authorization
```

`--check` proves the production host, the deployment lock, the staged `.reviewed-commit`, the exact Caddyfile hash, the running ingress image (it does not resolve the pinned digest for this comparison), the in-container loaded Caddyfile hash and a local Caddy validation, then prints either "already active" or the plan. It does not modify the Caddyfile or restart ingress; it does take the deployment lock. The activation discriminator is the Caddyfile hash the ingress has loaded, never the public key response, because the Node route also answers the key. Only a loaded hash equal to the reviewed hash means the ingress fallback is active. `--apply` restarts only the ingress container with `--no-deps`, then requires the loaded hash to equal the reviewed hash, the key body/type, a nonmatching path, foreign-host refusal, canonical HTTP redirect, application readiness and unchanged app/worker/database identities. The key, suffix, foreign-host and redirect probes are defence in depth, not proof that the ingress response replaced the Node route. On failure it restores the previously served configuration, restarts only ingress, verifies readiness and otherwise reports `RECOVERY REQUIRED` while preserving the running process; a rollback leaves the staged source at the previously served bytes until the next deployment. Evidence stays under `/opt/hatoove/ops/indexnow/<timestamp>`. Neither mode deploys application code, recreates app/worker, runs migrations or touches volumes, and possessing the script does not authorize production activation.

The focused tests mock IndexNow requests, cover malformed/foreign URLs and failed verification, and check exact Caddy path/body/status with negative mutations. They also assert that the deployment gate checks the live key body and type after the deploy step, that the ingress activation step inspects the loaded Caddyfile before restarting, that its activation discriminator is the loaded hash rather than the key response, and that it rejects direct deployment, migration and volume commands. The SEO regression test checks anonymous Node key access and the existing session gate. References: [IndexNow protocol](https://www.indexnow.org/documentation), [FAQ](https://www.indexnow.org/faq).

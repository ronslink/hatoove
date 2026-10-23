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

If a full application release would include unrelated changes, the reviewed `deploy/activate-ingress.sh` step loads only the already staged Caddyfile delta. It is dry-run by default and requires the fresh reviewed commit and Caddyfile SHA256:

```sh
deploy/activate-ingress.sh --check <reviewed-commit> <caddyfile-sha256>   # read-only preflight and plan
deploy/activate-ingress.sh --apply <reviewed-commit> <caddyfile-sha256>   # only with explicit authorization
```

`--check` proves the production host, the deployment lock, the staged `.reviewed-commit`, the exact Caddyfile hash, the pinned ingress image and a local Caddy validation, then prints the plan without restarting or writing anything. `--apply` restarts only the ingress container with `--no-deps`, then requires the key body/type, a nonmatching path, foreign-host refusal, canonical HTTP redirect, application readiness and unchanged app/worker/database identities. On failure it restores the previously served configuration, restarts only ingress, verifies readiness and otherwise reports `RECOVERY REQUIRED` while preserving the running process. Evidence stays under `/opt/hatoove/ops/indexnow/<timestamp>`. Neither mode deploys application code, recreates app/worker, runs migrations or touches volumes, and possessing the script does not authorize production activation.

The focused tests mock IndexNow requests, cover malformed/foreign URLs and failed verification, and check exact Caddy path/body/status with negative mutations. They also assert that the deployment gate checks the live key body and type, and that the ingress activation step stays read-only by default and restart-only-ingress. The SEO regression test checks anonymous Node key access and the existing session gate. References: [IndexNow protocol](https://www.indexnow.org/documentation), [FAQ](https://www.indexnow.org/faq).

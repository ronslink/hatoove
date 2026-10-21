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

If a full application release would include unrelated changes, an ingress-only alternative is to deploy just the reviewed Caddyfile delta. First inspect the current source/configuration and keep an exact backup. Validate with the currently pinned Caddy image, preserve the mounted file inode when writing it, and restart only ingress with `--no-deps`. Verify the key, nonmatching path, retained headers, foreign-host refusal, redirect, health and unchanged app/worker/database identities. On failure, restore and verify the original configuration before restarting ingress; if restoration cannot be verified, preserve the running process and require recovery. Neither method authorizes unrelated application changes or volume deletion.

The focused tests mock IndexNow requests, cover malformed/foreign URLs and failed verification, and check exact Caddy path/body/status with negative mutations. The SEO regression test checks anonymous Node key access and the existing session gate. References: [IndexNow protocol](https://www.indexnow.org/documentation), [FAQ](https://www.indexnow.org/faq).
